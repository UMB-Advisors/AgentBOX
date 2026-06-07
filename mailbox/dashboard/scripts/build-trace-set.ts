#!/usr/bin/env -S npx tsx
// dashboard/scripts/build-trace-set.ts
//
// STAQPRO-340 — export a stable, content-addressed trace set from a live
// appliance's Postgres for use by:
//
//   - STAQPRO-342 (three-way model bake-off)
//   - STAQPRO-343 (DSPy GEPA optimizer baseline)
//   - STAQPRO-344 (LoRA adapter validation)
//
// What this script does NOT do:
//
//   - Synthesize traces for `summarize-thread` / `escalate-to-human` /
//     `classify-and-file`. The v1.0 spec is `draft-reply` only — the other
//     three categories require either human labeling or LLM-synthesized
//     data, both of which are gated on operator approval and tracked in
//     STAQPRO-340.2.
//   - Capture 8K / 16K long-context traces. The current customer #1 corpus
//     doesn't hit 8K+ in a single inbound; the long-context tier is gated on
//     either a larger customer corpus or LLM-augmented thread concatenation
//     (STAQPRO-340.1).
//   - Commit the actual trace JSONL into git. The output directory should be
//     gitignored — `manifest.json` is committed; the `*.trace.json` files
//     live on the operator's workstation. See `eval/t2-traces/v1.1/README.md`
//     (or the historical `v1.0/README.md` for the pre-STAQPRO-365 baseline).
//
// Privacy: bodies are scrubbed via `lib/rag/scrub.ts:scrubPII` (phone, SSN,
// 16-digit card → tokens). Email addresses, URLs, and names are NOT scrubbed
// per the STAQPRO-193 locked decision — they're legitimate relationship
// signal for retrieval-augmented eval. The operator is responsible for not
// distributing the JSONL outside controlled storage.
//
// Run from inside the dashboard container, with POSTGRES_URL pointing at the
// appliance DB (e.g., via SSH tunnel: `ssh -L 5432:localhost:5432 mailbox1`):
//
//   POSTGRES_URL=postgresql://mailbox:<pw>@localhost:5432/mailbox \
//     npx tsx scripts/build-trace-set.ts \
//       --out eval/t2-traces/v1.1 \
//       --set-version v1.1 \
//       --appliance mailbox1 \
//       --limit 100
//
// Idempotent: re-runs against the same source DB rows produce byte-identical
// trace JSON (modulo the `extracted_at` timestamp in provenance, which the
// script keeps stable when `--extracted-at <iso>` is supplied).
//
// STAQPRO-365 (v1.1): adds two corpus-quality filters to `buildSourceSql`:
//   - drops rows whose `sent_history.draft_sent` looks like a forwarded
//     message or an inline quote-block reply (heuristic regex on the body
//     after the first 100 chars — false negatives OK, false positives bad);
//   - dedupes on `im.id` via `DISTINCT ON`, preferring non-forwarded → longest
//     body → earliest `sent_at` so a single canonical reply represents each
//     inbound. See `dashboard/eval/t2-traces/v1.1/README.md` for the v1.0 → v1.1
//     deltas and rationale.

import { createHash } from 'node:crypto';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Pool } from 'pg';
import {
  buildManifest,
  TRACE_FORMAT_VERSION,
  type Trace,
  type TraceManifest,
  type TraceScrubCounts,
  type TraceWithFilename,
  traceFilename,
  traceSchema,
  traceToCanonicalJson,
} from '../lib/eval/trace-set';
import { scrubPII } from '../lib/rag/scrub';

// =============================================================================
// CLI argument parsing
// =============================================================================

interface ParsedArgs {
  out: string;
  setVersion: string;
  appliance: string;
  limit: number;
  extractedAt: string;
  clean: boolean;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  // Defaults updated to v1.1 (STAQPRO-365). Operator can still target v1.0 by
  // passing `--out eval/t2-traces/v1.0 --set-version v1.0` explicitly, but the
  // v1.1 SQL filters are baked in — the v1.0 directory will receive
  // forwarded-filtered + dedup'd traces, NOT the byte-identical v1.0 set.
  let out = 'eval/t2-traces/v1.1';
  let setVersion = 'v1.1';
  let appliance = process.env.MAILBOX_APPLIANCE_ID ?? 'unknown';
  let limit = 50;
  let extractedAt = new Date().toISOString();
  let clean = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      out = required(argv[i + 1], '--out');
      i++;
      continue;
    }
    if (a === '--set-version') {
      setVersion = required(argv[i + 1], '--set-version');
      i++;
      continue;
    }
    if (a === '--appliance') {
      appliance = required(argv[i + 1], '--appliance');
      i++;
      continue;
    }
    if (a === '--limit') {
      const n = Number(required(argv[i + 1], '--limit'));
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit must be a positive number, got: ${argv[i + 1]}`);
      }
      limit = Math.floor(n);
      i++;
      continue;
    }
    if (a === '--extracted-at') {
      // Lets a re-run produce byte-identical manifest by pinning the
      // provenance timestamp.
      extractedAt = required(argv[i + 1], '--extracted-at');
      i++;
      continue;
    }
    if (a === '--clean') {
      // Delete `*.trace.json` files in the output dir before writing the new
      // set. Off by default to avoid surprise data loss.
      clean = true;
      continue;
    }
    if (a === '--dry-run') {
      // Print what would be written; don't write anything.
      dryRun = true;
      continue;
    }
    throw new Error(`unknown arg: ${a}`);
  }

  return { out, setVersion, appliance, limit, extractedAt, clean, dryRun };
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === '') {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

// =============================================================================
// Source query
// =============================================================================

/**
 * Shape of a row coming off the pg driver. Numeric DB types arrive as
 * strings because of `pg`'s default `setTypeParser` behavior for `bigint`
 * (sh.id) and `numeric` (im.confidence) — the project preserves that
 * convention to avoid JS Number precision loss on bigints (see root
 * CLAUDE.md "pg setTypeParser" convention).
 *
 * `rowToTrace` is responsible for coercing these into the `Trace` shape's
 * declared numeric fields. `integer` columns (`im.id`) DO arrive as JS
 * `number` so they stay as `number` here; we still defensively coerce in
 * `rowToTrace` in case pg ever changes its default.
 */
interface SourceRow {
  sent_history_id: string; // bigint → string
  inbox_id: number; // integer → number
  inbox_message_id: string;
  inbox_thread_id: string | null;
  inbox_from: string | null;
  inbox_subject: string | null;
  inbox_body: string;
  inbox_classification: string | null;
  inbox_confidence: string | null; // numeric → string
  actual_reply_body: string;
  reply_sent_at: string | Date; // timestamptz → Date (unless setTypeParser overridden)
}

/**
 * Forwarded / quote-block heuristic (STAQPRO-365).
 *
 * Matches the first non-whitespace token after the 100th character of
 * `sent_history.draft_sent`. If that token looks like a forward separator
 * (`---+`), a "On <Day>, <Person> wrote:" quote header, or an inline quote
 * marker (`>`), we mark the row as forwarded/quoted and either drop it or
 * deprioritize it.
 *
 * Bias: false negatives OK (a few forwards leaking through), false positives
 * bad (a real reply that happens to contain `---` or `>` in its body
 * MUST NOT be dropped). The 100-char offset guarantees we don't trip on
 * a reply that opens with `---` then has a real message below — and the
 * regex anchors to start-of-line (after whitespace) so prose containing
 * `---` mid-paragraph is safe.
 *
 * SQL regex syntax: Postgres POSIX. `\m` is word-boundary,
 * `[[:space:]]` is whitespace, capture groups not needed.
 *
 * Note: keep the literal regex string in sync with the JS-side validation
 * regex in `test/scripts/build-trace-set.test.ts` (the test asserts both
 * sides reject the same fixtures).
 */
const FORWARDED_BODY_REGEX_SQL = String.raw`^[[:space:]]*(-{3,}|On[[:space:]]+\w+,?[[:space:]]+\w+|>{1,})`;

/**
 * SQL is structured in two layers per STAQPRO-365:
 *
 *   1. `candidates` CTE — applies the v1.0 join + the new forwarded filter
 *      (rows whose tail body matches the FORWARDED regex are dropped). Also
 *      computes `is_forwarded_head` (whether the *head* of the body — first
 *      100 chars — looks forwarded) and `body_len` for the dedup ORDER BY.
 *      Forwarded-head detection is permissive (no SUBSTR offset) so it
 *      catches forwards even when the tail wouldn't.
 *
 *   2. The outer `SELECT DISTINCT ON (im.id)` picks one row per inbound,
 *      preferring (a) non-forwarded head, (b) longest body, (c) earliest
 *      `sent_at`. The outer `ORDER BY` then re-sorts the chosen rows by
 *      classification ASC NULLS LAST + sent_at ASC for the limit cut —
 *      same stratification as v1.0.
 *
 * Why the WHERE-clause regex uses SUBSTR offset 100 but the column
 * `is_forwarded_head` does not: the WHERE clause is the "drop entirely"
 * filter and we want it conservative (only kill rows whose forward signal
 * appears mid-body, after a likely-real header). The column is just a
 * priority hint inside the dedup ORDER BY — false positives there are
 * fine because the rest of the priority chain (body_len, sent_at) still
 * picks a sensible row.
 *
 * Stratification at the tail: NULLs sort last in ASC, so unclassified pairs
 * end up at the tail rather than dominating the head. Within each
 * classification the order is by `sent_at` ASC (oldest first) — same
 * convention as the existing harness for reproducibility.
 */
interface SourceQuery {
  text: string;
  values: readonly string[];
}

// Returns a parameterized query — the forwarded-body regex is passed as $1/$2
// rather than interpolated. Per the dashboard `CLAUDE.md` SQL convention:
// "always parameterize — never string-concatenate user input into SQL." The
// regex is currently a module-level constant with no user input, but the
// parameterized form removes a correctness landmine if the regex ever
// changes to contain SQL metacharacters (e.g., a single-quote).
function buildSourceSql(limit: number): SourceQuery {
  const text = `
    WITH candidates AS (
      SELECT
        sh.id                          AS sent_history_id,
        im.id                          AS inbox_id,
        im.message_id                  AS inbox_message_id,
        im.thread_id                   AS inbox_thread_id,
        im.from_addr                   AS inbox_from,
        im.subject                     AS inbox_subject,
        im.body                        AS inbox_body,
        im.classification              AS inbox_classification,
        im.confidence                  AS inbox_confidence,
        sh.draft_sent                  AS actual_reply_body,
        sh.sent_at                     AS reply_sent_at,
        char_length(sh.draft_sent)     AS body_len,
        (sh.draft_sent ~ $1) AS is_forwarded_head
      FROM mailbox.sent_history sh
      JOIN mailbox.inbox_messages im ON im.id = sh.inbox_message_id
      WHERE sh.source = 'backfill'
        AND sh.inbox_message_id IS NOT NULL
        AND COALESCE(sh.draft_sent, '') <> ''
        AND COALESCE(im.body, '') <> ''
        -- STAQPRO-365 forwarded filter. Look for forward/quote markers in
        -- the body AFTER the first 100 chars: that's how forwarded messages
        -- present in this corpus (operator preface + separator + chain).
        -- A reply that genuinely opens with three dashes is fine because we
        -- anchor the regex to the offset-100 tail, not the head.
        AND SUBSTRING(sh.draft_sent FROM 101) !~ $2
    )
    SELECT
      sent_history_id, inbox_id, inbox_message_id, inbox_thread_id,
      inbox_from, inbox_subject, inbox_body,
      inbox_classification, inbox_confidence,
      actual_reply_body, reply_sent_at
    FROM (
      SELECT DISTINCT ON (inbox_id) *
      FROM candidates
      -- Per-inbound canonical pick: non-forwarded head wins over forwarded,
      -- then longest body (more signal), then earliest reply (closest to
      -- the inbound — most contextually relevant). All deterministic so
      -- re-runs are byte-identical.
      ORDER BY inbox_id,
               is_forwarded_head ASC,    -- false < true → non-forwarded first
               body_len DESC,
               reply_sent_at ASC,
               sent_history_id ASC        -- final tiebreak for stability
    ) deduped
    ORDER BY inbox_classification ASC NULLS LAST, reply_sent_at ASC
    LIMIT ${Math.max(1, Math.floor(limit))}
  `;
  return { text, values: [FORWARDED_BODY_REGEX_SQL, FORWARDED_BODY_REGEX_SQL] };
}

// =============================================================================
// Row → Trace transformation
// =============================================================================

interface ScrubbedRow {
  trace: Trace;
}

function rowToTrace(row: SourceRow, appliance: string, extractedAt: string): ScrubbedRow {
  const scrubbedInbox = scrubPII(row.inbox_body);
  const scrubbedReply = scrubPII(row.actual_reply_body);

  const scrub_counts: TraceScrubCounts = {
    phone: scrubbedInbox.counts.phone + scrubbedReply.counts.phone,
    ssn: scrubbedInbox.counts.ssn + scrubbedReply.counts.ssn,
    card: scrubbedInbox.counts.card + scrubbedReply.counts.card,
  };

  const trace: Trace = {
    format_version: TRACE_FORMAT_VERSION,
    workflow_category: 'draft-reply',
    classification: classificationOrNull(row.inbox_classification),
    inbox_message_id: row.inbox_message_id,
    inbox_thread_id: row.inbox_thread_id,
    inbox_from: row.inbox_from,
    inbox_subject: row.inbox_subject,
    inbox_body: scrubbedInbox.text,
    inbox_confidence: numberOrNull(row.inbox_confidence),
    actual_reply_body: scrubbedReply.text,
    // pg returns `timestamp`/`timestamptz` as a JS Date by default. The
    // dashboard runtime's `lib/db.ts` overrides this via setTypeParser to
    // keep timestamps as strings, but this script imports `Pool` from `pg`
    // directly (it doesn't load `lib/db.ts`) so the overrides don't apply
    // here. Coerce Date → ISO-8601 string at the construction boundary.
    reply_sent_at: isoDateString(row.reply_sent_at),
    provenance: {
      appliance,
      // Coerce bigint sh.id (pg-driver string) and defensively coerce inbox_id
      // (currently integer/number but cheap insurance against future pg changes).
      sent_history_id: Number(row.sent_history_id),
      inbox_id: Number(row.inbox_id),
      extracted_at: extractedAt,
      scrub_counts,
    },
  };

  // Defensive: fail fast if a field-shape regression slips through. This
  // catches things like a future pg type-parser change or a new column added
  // to SourceRow without updating the coercion. Without this guard, the
  // failure mode is silent corpus poisoning — downstream consumers
  // (rag-eval-harness loader, bake-off harness) reject the trace at LOAD time,
  // not GEN time, which is much harder to debug.
  traceSchema.parse(trace);

  return { trace };
}

/**
 * Coerce a possibly-string-shaped numeric DB value (per pg-driver's default
 * bigint/numeric → string) into a finite JS number, or null if absent or
 * non-finite. Used for `inbox_confidence` (numeric → string) at the
 * Trace-construction boundary.
 */
function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Coerce a pg-driver timestamp value (JS Date by default — see comment in
 * `rowToTrace` for why this script doesn't get the `lib/db.ts` setTypeParser
 * overrides) into an ISO-8601 string. Accepts pre-stringified inputs
 * verbatim so the function also works against fixture rows.
 */
function isoDateString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  // Defensive: any other shape (number-as-millis, etc.) — let JS try.
  return new Date(v as never).toISOString();
}

/**
 * Narrow the DB-string-typed classification into the `Category` union or
 * null. The trace schema accepts `string | null` so we don't have to
 * pre-validate against the enum here — but we DO drop empty strings to
 * `null` for consistency with how the live drafter treats them.
 */
function classificationOrNull(raw: string | null): Trace['classification'] {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // Cast is safe: `Category` is a union of strings, the harness already
  // tolerates unrecognized values via `(... as Category | null) ?? 'inquiry'`
  // in generateDraft. Keeping the raw DB value preserves the bake-off's
  // ability to detect classifier drift.
  return trimmed as Trace['classification'];
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const postgresUrl = process.env.POSTGRES_URL;
  if (!postgresUrl) throw new Error('POSTGRES_URL not set');

  console.log(
    `[build-trace-set] out=${args.out} set_version=${args.setVersion} appliance=${args.appliance} limit=${args.limit} dry_run=${args.dryRun}`,
  );

  const pool = new Pool({ connectionString: postgresUrl, max: 2 });
  const rows: SourceRow[] = [];
  try {
    const q = buildSourceSql(args.limit);
    const r = await pool.query<SourceRow>(q.text, [...q.values]);
    rows.push(...r.rows);
  } finally {
    await pool.end();
  }
  console.log(`[build-trace-set] selected ${rows.length} source rows`);

  if (rows.length === 0) {
    throw new Error('no rows returned — check sh.source=backfill rows exist in the source DB');
  }

  // Convert rows to traces. Each trace's filename is derived from its
  // SHA-256 (content-addressed), so two rows with identical bytes produce
  // identical filenames — but the SQL dedup on `inbox_message_id` already
  // guarantees that can't happen on real data.
  const tracesWithFilenames: TraceWithFilename[] = rows.map((row) => {
    const { trace } = rowToTrace(row, args.appliance, args.extractedAt);
    return { trace, filename: traceFilename(trace) };
  });

  // Defense against the SHA-prefix-collision corner case (vanishingly
  // unlikely at n=50, but cheap to assert).
  const filenameSet = new Set(tracesWithFilenames.map((t) => t.filename));
  if (filenameSet.size !== tracesWithFilenames.length) {
    throw new Error(
      `trace filename collision detected — bump the prefix length in traceFilename()`,
    );
  }

  const manifest: TraceManifest = buildManifest({
    set_version: args.setVersion,
    source_appliance: args.appliance,
    generated_at: args.extractedAt,
    traces: tracesWithFilenames,
  });

  if (args.dryRun) {
    console.log('[build-trace-set] DRY RUN — would write:');
    for (const t of tracesWithFilenames) {
      console.log(`  ${path.join(args.out, t.filename)}`);
    }
    console.log(`  ${path.join(args.out, 'manifest.json')}`);
    console.log(`[build-trace-set] set_sha256=${manifest.set_sha256}`);
    return;
  }

  await mkdir(args.out, { recursive: true });

  // --clean removes prior `*.trace.json` files in the output dir. Leaves
  // `manifest.json` and `README.md` and any other non-trace files alone.
  if (args.clean) {
    const existing = await readdir(args.out);
    for (const name of existing) {
      if (name.endsWith('.trace.json')) {
        await unlink(path.join(args.out, name));
      }
    }
  }

  for (const { trace, filename } of tracesWithFilenames) {
    const filepath = path.join(args.out, filename);
    await writeFile(filepath, traceToCanonicalJson(trace), 'utf-8');
  }

  const manifestPath = path.join(args.out, 'manifest.json');
  // Manifest gets the same trailing-newline convention as the trace files
  // for tidy diffs.
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  // Echo the SHA over the manifest file itself so the operator can later
  // pin against the exact file (useful for run-tagging in the eval report).
  const manifestSha = createHash('sha256')
    .update(`${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
    .digest('hex');

  console.log(`[build-trace-set] wrote ${tracesWithFilenames.length} trace files`);
  console.log(`[build-trace-set] manifest_sha256=${manifestSha}`);
  console.log(`[build-trace-set] set_sha256=${manifest.set_sha256}`);
  console.log(`[build-trace-set] manifest=${manifestPath}`);
}

// Only run when invoked directly (not when imported by tests).
const isDirect =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /build-trace-set\.(ts|js|mjs|cjs)$/.test(process.argv[1]);

if (isDirect) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export type { ParsedArgs, SourceRow };
// Exports for unit tests
export { buildSourceSql, FORWARDED_BODY_REGEX_SQL, parseArgs, rowToTrace };
