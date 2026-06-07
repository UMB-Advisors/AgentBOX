// dashboard/lib/eval/trace-set.ts
//
// STAQPRO-340 — trace-set abstraction for the §5.8 eval harness.
//
// Why this layer exists (vs the live DB-driven path in
// scripts/rag-eval-harness.ts): the DB-driven path reads `(inbound, reply)`
// pairs from `mailbox.sent_history` on every run. That's correct for
// "is RAG helping today?" — but useless for the three downstream issues
// that need a stable, reproducible benchmark:
//
//   - STAQPRO-342 (three-way model bake-off) — three model runs MUST hit the
//     same traces or the comparison is invalid.
//   - STAQPRO-343 (DSPy GEPA) — gradient signal across prompt mutations
//     requires the input distribution to be frozen.
//   - STAQPRO-344 (per-customer LoRA validation) — the adapter must clear an
//     eval gate that doesn't move out from under it as the live corpus grows.
//
// The trace set is a point-in-time, content-addressed snapshot of n pairs.
// Each trace is a JSON document; a SHA-256 manifest binds the set together
// so reviewers can verify they're evaluating the same inputs.
//
// Privacy: the actual trace JSONL is gitignored under `dashboard/eval/` (real
// customer-#1 email bodies, even PII-scrubbed, are not committed to a public
// repo). What IS committed: this module, the manifest schema, the build
// script, the README, and a `manifest.example.json` reference. The runbook
// (docs/runbook/rag-eval.v0.5.0.md) documents how to regenerate the JSONL
// from a live appliance.

import { createHash } from 'node:crypto';
import { z } from 'zod';

// =============================================================================
// Format version
// =============================================================================

/**
 * Bump this when the trace JSON shape changes in a way that's not
 * backward-compatible. Older runs against an older format are invalid; the
 * harness asserts `format_version` matches before scoring.
 *
 * v1 covers draft-reply only (the existing harness scope). v1.1 will add the
 * 8K/16K long-context tier and tracks under STAQPRO-340.1.
 */
export const TRACE_FORMAT_VERSION = 'v1' as const;
export type TraceFormatVersion = typeof TRACE_FORMAT_VERSION;

/**
 * Workflow category for the trace — currently `draft-reply` only.
 *
 * The three placeholder values (`classify-and-file`, `summarize-thread`,
 * `escalate-to-human`) are reserved for STAQPRO-340.2 (synthetic / labeled
 * traces). They appear here so the type is forward-compatible — the build
 * script today emits `draft-reply` exclusively.
 */
export const TRACE_WORKFLOW_CATEGORIES = [
  'draft-reply',
  'classify-and-file',
  'summarize-thread',
  'escalate-to-human',
] as const;

export type TraceWorkflowCategory = (typeof TRACE_WORKFLOW_CATEGORIES)[number];

// =============================================================================
// Trace shape
// =============================================================================

/**
 * Single trace = one `(inbound, reply)` pair plus the metadata needed to
 * route it through the live drafter exactly the way the production path
 * would route it.
 *
 * Field ordering in this interface is significant: `traceToCanonicalJson`
 * emits keys in the order declared here. Reordering means SHA-256s shift —
 * coordinate with a format-version bump.
 */
export interface Trace {
  /** Trace format version. Asserted by the harness on load. */
  format_version: TraceFormatVersion;
  /** Workflow category. v1 = `'draft-reply'` only. */
  workflow_category: TraceWorkflowCategory;
  /**
   * Live classification category at curation time (drives router LOCAL vs
   * CLOUD when the harness scores the trace). Stored as `string | null`
   * rather than the strict `Category` union: the harness must surface
   * classifier drift between corpora, and refusing to load a trace whose
   * classification doesn't match today's `Category` enum would silently
   * drop those rows. The harness narrows via `as Category` at use-site,
   * with an `'inquiry'` fallback (same convention as the DB-driven path).
   */
  classification: string | null;
  /** Original Gmail message-id of the inbound. Stable across reruns. */
  inbox_message_id: string;
  /** Thread-id (used by retrieve.ts H3 same-thread-suppression). */
  inbox_thread_id: string | null;
  /** PII-scrubbed sender. Bare addr, no display name. */
  inbox_from: string | null;
  /** Subject — passed verbatim; not scrubbed. */
  inbox_subject: string | null;
  /** PII-scrubbed inbound body (phone/SSN/card → tokens via scrubPII). */
  inbox_body: string;
  /** Classifier confidence captured at curation time. */
  inbox_confidence: number | null;
  /** PII-scrubbed reply body — the human-curated preferred output. */
  actual_reply_body: string;
  /** ISO-8601 timestamp the reply was sent. Stable across reruns. */
  reply_sent_at: string;
  /**
   * Provenance metadata. Carries the source DB identifiers + scrub counts so
   * an operator can audit a trace back to its source row.
   */
  provenance: TraceProvenance;
}

export interface TraceProvenance {
  /** Source customer appliance id (e.g., `mailbox1`, `mailbox2`). */
  appliance: string;
  /** Numeric id of the source `mailbox.sent_history` row. */
  sent_history_id: number;
  /** Numeric id of the source `mailbox.inbox_messages` row. */
  inbox_id: number;
  /** ISO-8601 timestamp the trace was extracted. */
  extracted_at: string;
  /** Per-pattern PII scrub counts across inbound+reply bodies combined. */
  scrub_counts: TraceScrubCounts;
}

export interface TraceScrubCounts {
  phone: number;
  ssn: number;
  card: number;
}

// =============================================================================
// Manifest
// =============================================================================

/**
 * Manifest binds a directory of trace files into a single content-addressed
 * unit. The `set_sha256` is computed over the sorted concatenation of every
 * trace's `trace_sha256`, which means:
 *
 *   - Two manifests with identical `set_sha256` describe identical input.
 *   - Adding / removing / mutating a single trace flips `set_sha256`.
 *   - The order of traces in the directory does NOT affect `set_sha256` —
 *     they're sorted by `inbox_message_id` before hashing, so a re-export
 *     against the same source rows in a different order yields the same
 *     manifest.
 */
export interface TraceManifest {
  format_version: TraceFormatVersion;
  /** Logical version of the set (`v1.0`, `v1.1`, ...). Independent of `format_version`. */
  set_version: string;
  /** ISO-8601 timestamp the manifest was generated. */
  generated_at: string;
  /** Source appliance id (e.g., `mailbox1`). */
  source_appliance: string;
  /** Total trace count. */
  count: number;
  /** SHA-256 over sorted concat of every entry's `trace_sha256`. */
  set_sha256: string;
  /**
   * One entry per trace, sorted by `inbox_message_id`. Each entry binds a
   * filename to its SHA-256 over the canonical trace JSON.
   */
  entries: TraceManifestEntry[];
}

export interface TraceManifestEntry {
  filename: string;
  inbox_message_id: string;
  workflow_category: TraceWorkflowCategory;
  /** Mirrors `Trace.classification` — `string | null`, not strict `Category`. */
  classification: string | null;
  trace_sha256: string;
}

// =============================================================================
// Hashing + canonical JSON
// =============================================================================

/**
 * SHA-256 hex digest of a UTF-8 string. Thin wrapper around node:crypto so
 * the call sites stay readable; not exported beyond the module.
 */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Emit a trace as canonical JSON. Canonicalization is deliberately simple
 * (sorted keys via JSON.stringify with a sort-stable replacer, two-space
 * indent for human diff-ability, trailing newline) — robust enough to give
 * stable SHA-256s across machines / Node versions, but not full JSON
 * Canonicalization Scheme (JCS / RFC 8785). Good enough for offline eval
 * trace integrity; not appropriate for cryptographic non-repudiation.
 *
 * Two-space indent is intentional: file-level diffs stay readable when an
 * operator wants to inspect a regression. The harness reads via JSON.parse
 * which doesn't care about whitespace.
 */
export function traceToCanonicalJson(trace: Trace): string {
  return `${JSON.stringify(trace, sortedReplacer, 2)}\n`;
}

/**
 * JSON.stringify replacer that walks the input and emits objects with their
 * keys sorted alphabetically. Arrays preserve order (they're positional).
 *
 * Defensive: skips functions, symbols, undefined values — those don't
 * survive a JSON round-trip anyway, so they'd be a bug in the caller.
 */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = obj[k];
  }
  return sorted;
}

/**
 * Compute the SHA-256 of a single trace. Caller is responsible for emitting
 * the same canonical JSON when persisting to disk — `traceToCanonicalJson`
 * is the single source of truth.
 */
export function hashTrace(trace: Trace): string {
  return sha256Hex(traceToCanonicalJson(trace));
}

/**
 * Build a `TraceManifest` from a list of traces. The set-level SHA-256 is
 * computed over the SORTED concatenation of per-trace SHAs (sort key:
 * `inbox_message_id`) — making it independent of the order the build script
 * processed the rows.
 */
export interface BuildManifestArgs {
  set_version: string;
  source_appliance: string;
  generated_at: string;
  traces: readonly TraceWithFilename[];
}

export interface TraceWithFilename {
  trace: Trace;
  filename: string;
}

export function buildManifest(args: BuildManifestArgs): TraceManifest {
  const entries: TraceManifestEntry[] = args.traces
    .map(({ trace, filename }) => ({
      filename,
      inbox_message_id: trace.inbox_message_id,
      workflow_category: trace.workflow_category,
      classification: trace.classification,
      trace_sha256: hashTrace(trace),
    }))
    .sort((a, b) => a.inbox_message_id.localeCompare(b.inbox_message_id));

  const concat = entries.map((e) => e.trace_sha256).join('');
  const set_sha256 = sha256Hex(concat);

  return {
    format_version: TRACE_FORMAT_VERSION,
    set_version: args.set_version,
    generated_at: args.generated_at,
    source_appliance: args.source_appliance,
    count: entries.length,
    set_sha256,
    entries,
  };
}

/**
 * Canonical filename for a trace file: first 16 hex chars of the trace
 * SHA-256 + `.trace.json`. Short enough to be tab-completable on the CLI;
 * collision-resistant within any realistic n=10000 set (2^64 birthday
 * boundary is ~4B sets of size ~4B before a collision is likely).
 */
export function traceFilename(trace: Trace): string {
  return `${hashTrace(trace).slice(0, 16)}.trace.json`;
}

// =============================================================================
// Zod schemas (load path)
// =============================================================================

/**
 * Strict zod schema for `Trace`. The harness uses this to reject corrupted
 * or stale-format-version files at load time rather than at first
 * use-site. zod's `.strict()` rejects unknown keys — if a future format
 * version adds a field, the harness fails loud rather than silently
 * dropping data.
 */
export const traceSchema = z
  .object({
    format_version: z.literal(TRACE_FORMAT_VERSION),
    workflow_category: z.enum(TRACE_WORKFLOW_CATEGORIES),
    classification: z.string().nullable(),
    inbox_message_id: z.string().min(1),
    inbox_thread_id: z.string().nullable(),
    inbox_from: z.string().nullable(),
    inbox_subject: z.string().nullable(),
    inbox_body: z.string(),
    inbox_confidence: z.number().nullable(),
    actual_reply_body: z.string(),
    reply_sent_at: z.string().min(1),
    provenance: z
      .object({
        appliance: z.string().min(1),
        sent_history_id: z.number().int().nonnegative(),
        inbox_id: z.number().int().nonnegative(),
        extracted_at: z.string().min(1),
        scrub_counts: z
          .object({
            phone: z.number().int().nonnegative(),
            ssn: z.number().int().nonnegative(),
            card: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const traceManifestEntrySchema = z
  .object({
    filename: z.string().min(1),
    inbox_message_id: z.string().min(1),
    workflow_category: z.enum(TRACE_WORKFLOW_CATEGORIES),
    classification: z.string().nullable(),
    trace_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'trace_sha256 must be 64 lowercase hex chars'),
  })
  .strict();

export const traceManifestSchema = z
  .object({
    format_version: z.literal(TRACE_FORMAT_VERSION),
    set_version: z.string().min(1),
    generated_at: z.string().min(1),
    source_appliance: z.string().min(1),
    count: z.number().int().nonnegative(),
    set_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'set_sha256 must be 64 lowercase hex chars'),
    entries: z.array(traceManifestEntrySchema),
  })
  .strict();

/**
 * Verify a manifest's `set_sha256` is consistent with its `entries`. Returns
 * `{ ok: true }` on success, `{ ok: false, reason }` on mismatch. The
 * harness calls this before scoring — if a manifest has drifted from its
 * entries (e.g., a trace got deleted but manifest wasn't regenerated), the
 * eval refuses to run.
 */
export interface ManifestVerifyOk {
  ok: true;
}

export interface ManifestVerifyFail {
  ok: false;
  reason: 'count_mismatch' | 'set_sha256_mismatch';
  expected?: string;
  actual?: string;
}

export type ManifestVerifyResult = ManifestVerifyOk | ManifestVerifyFail;

export function verifyManifest(manifest: TraceManifest): ManifestVerifyResult {
  if (manifest.entries.length !== manifest.count) {
    return { ok: false, reason: 'count_mismatch' };
  }
  const sorted = [...manifest.entries].sort((a, b) =>
    a.inbox_message_id.localeCompare(b.inbox_message_id),
  );
  const concat = sorted.map((e) => e.trace_sha256).join('');
  const computed = sha256Hex(concat);
  if (computed !== manifest.set_sha256) {
    return {
      ok: false,
      reason: 'set_sha256_mismatch',
      expected: manifest.set_sha256,
      actual: computed,
    };
  }
  return { ok: true };
}
