import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import {
  type ClassifyOneDeps,
  classifyOne,
  type InboxRowForClassify,
} from './classification/classify-one';

// MBOX-370 — never-spam allowlist write path + "reclassify automatically" action.
//
// Split into instant vs slow halves (MBOX-370 follow-up fix):
//   - upsertNeverSpam()  — the FUTURE rule. Instant single upsert. This is the
//     part that actually matters (the classify-time guard surfaces, never drops,
//     this sender going forward).
//   - reclassifySenderEmails() — the PAST re-run. Up to RECLASSIFY_CAP local LLM
//     calls (classifyOne), one per email. SLOW (seconds each). The route fires
//     this in the BACKGROUND so the HTTP response returns immediately — re-running
//     50 emails synchronously held the request open for minutes and greyed the UI.
//
// Relabel only — NO drafts are generated for historical mail (operator decision
// 2026-05-30). Future inbound from the sender drafts normally via the live pipeline.
//
// Each email gets a classification_log row (the audit record) AND an explicit
// inbox_messages denorm update ({classification,confidence,classified_at,model}).
// On the live appliance the migration-021 trigger ALSO syncs inbox_messages off
// the log insert, but we write it explicitly too — matching the MBOX-123 precedent
// ("correct even if the trigger is ever disabled") and so it works in test/codegen
// fixtures that don't carry the trigger.

// Cap the re-classify fan-out per sender. Each email is one local LLM call; the
// loop runs in the background so this just bounds total work + duplicate effort.
const RECLASSIFY_CAP = 50;

// Per-email classify timeout. Guards the BACKGROUND loop from wedging on a single
// hung Ollama call — on timeout we skip that email and move on (it keeps its
// current label; the sender is already allowlisted for the future).
const PER_CLASSIFY_TIMEOUT_MS = 30_000;

// Bare-address extraction in SQL, mirroring lib/classification/preclass.ts
// extractAddress(): angle-bracket address if present, else the trimmed whole,
// lowercased. Keeps the match aligned with the stored allowlist email.
const BARE_ADDR_SQL = sql<string>`lower(coalesce(substring(from_addr from '<([^>]+)>'), trim(from_addr)))`;

/** Upsert the sender onto the never-spam allowlist (idempotent on unique email). */
export async function upsertNeverSpam(email: string, reason: string | null): Promise<void> {
  await getKysely()
    .insertInto('sender_never_spam')
    .values({ email, reason, created_by: 'operator' })
    .onConflict((oc) => oc.column('email').doUpdateSet({ reason, updated_at: sql<string>`NOW()` }))
    .execute();
}

/** Count how many existing emails from this sender would be re-classified. */
export async function countSenderEmails(
  email: string,
): Promise<{ count: number; capped: boolean }> {
  const rows = await getKysely()
    .selectFrom('inbox_messages')
    .select('id')
    .where(sql<boolean>`${BARE_ADDR_SQL} = ${email}`)
    .orderBy('id', 'desc')
    .limit(RECLASSIFY_CAP + 1)
    .execute();
  const capped = rows.length > RECLASSIFY_CAP;
  return { count: capped ? RECLASSIFY_CAP : rows.length, capped };
}

async function classifyWithTimeout(row: InboxRowForClassify, deps?: ClassifyOneDeps) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`classifyOne timeout after ${PER_CLASSIFY_TIMEOUT_MS}ms`)),
      PER_CLASSIFY_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([classifyOne(row, deps), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ReclassifyEmailsResult {
  reclassified: number;
  // How many re-classified rows were spam verdicts surfaced to unknown by the
  // never-spam guard (vs. the model naturally returning a non-spam type).
  surfaced: number;
  truncated: boolean;
}

/**
 * Re-run the classifier on the sender's existing emails (newest first, capped).
 * SLOW — intended to run in the background. Not transactional: each log insert +
 * denorm update is atomic per email; one email's failure skips just that email.
 */
export async function reclassifySenderEmails(
  email: string,
  deps?: ClassifyOneDeps,
): Promise<ReclassifyEmailsResult> {
  const db = getKysely();

  const rows = await db
    .selectFrom('inbox_messages')
    .select(['id', 'from_addr', 'to_addr', 'subject', 'body', 'snippet'])
    .where(sql<boolean>`${BARE_ADDR_SQL} = ${email}`)
    .orderBy('id', 'desc')
    .limit(RECLASSIFY_CAP + 1)
    .execute();

  const truncated = rows.length > RECLASSIFY_CAP;
  const batch = truncated ? rows.slice(0, RECLASSIFY_CAP) : rows;

  let reclassified = 0;
  let surfaced = 0;

  for (const row of batch) {
    const inboxRow: InboxRowForClassify = {
      id: row.id,
      from_addr: row.from_addr,
      to_addr: row.to_addr,
      subject: row.subject,
      body: row.body,
      snippet: row.snippet,
    };

    let category = '';
    let confidence = 0;
    let modelVersion = '';
    let latencyMs: number | null = null;
    let rawOutput = '';
    let jsonParseOk = false;
    let thinkStripped = false;
    try {
      // Sender is allowlisted by construction here → neverSpam disables the
      // heuristic suppressions inside normalize: operator-domain mail resolves to
      // `internal`, the model's real category stands otherwise, and a genuine
      // model spam_marketing verdict is surfaced to `unknown` (preclass_source
      // 'sender-never-spam'). Mirrors the live classification-normalize path.
      const r = await classifyWithTimeout(inboxRow, { ...deps, neverSpam: true });
      category = r.category;
      confidence = r.confidence;
      modelVersion = r.model_version;
      latencyMs = r.latency_ms;
      rawOutput = r.raw_output;
      jsonParseOk = r.json_parse_ok;
      thinkStripped = r.think_stripped;
      if (r.preclass_source === 'sender-never-spam') surfaced += 1;
    } catch (error) {
      console.error(
        `[reclassify] classifyOne failed/timed out for inbox ${row.id} — skipping:`,
        error,
      );
      continue;
    }

    await db
      .insertInto('classification_log')
      .values({
        inbox_message_id: row.id,
        category,
        confidence,
        model_version: modelVersion,
        latency_ms: latencyMs,
        raw_output: rawOutput,
        json_parse_ok: jsonParseOk,
        think_stripped: thinkStripped,
      })
      .execute();

    // Explicit denorm write (see header note) — keeps inbox_messages correct
    // independent of the migration-021 trigger.
    await db
      .updateTable('inbox_messages')
      .set({
        classification: category,
        confidence,
        classified_at: sql<string>`NOW()`,
        model: modelVersion,
      })
      .where('id', '=', row.id)
      .execute();
    reclassified += 1;
  }

  return { reclassified, surfaced, truncated };
}

export interface ReclassifySenderResult extends ReclassifyEmailsResult {
  email: string;
  allowlisted: boolean;
}

/**
 * Synchronous full flow (upsert + re-classify), awaiting everything. Used by the
 * tests and any caller that wants to block. The ROUTE does NOT use this — it
 * upserts, then backgrounds reclassifySenderEmails so the response is instant.
 */
export async function reclassifyBySender(input: {
  email: string;
  reason: string | null;
  deps?: ClassifyOneDeps;
}): Promise<ReclassifySenderResult> {
  await upsertNeverSpam(input.email, input.reason);
  const r = await reclassifySenderEmails(input.email, input.deps);
  return { email: input.email, allowlisted: true, ...r };
}

export interface NeverSpamRow {
  id: number;
  email: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export async function listNeverSpamSenders(): Promise<NeverSpamRow[]> {
  const rows = await getKysely()
    .selectFrom('sender_never_spam')
    .select(['id', 'email', 'reason', 'created_at', 'updated_at', 'created_by'])
    .orderBy('updated_at', 'desc')
    .execute();
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
