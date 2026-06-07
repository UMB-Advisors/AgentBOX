import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import type { ExtractInput } from '@/lib/persona/extract';
import type { RejectFeedbackInput } from '@/lib/persona/reject-signals';
import { getDefaultAccountId } from '@/lib/queries-accounts';
import { normalizeSender } from '@/lib/rag/qdrant';
import type { Persona, RejectReasonCode } from '@/lib/types';

const DEFAULT_EXTRACTION_LIMIT = 200;

// MBOX-352 (MBOX-162 V2) — every persona/extraction read is now account-scoped.
// account_id is optional on each helper and falls back to the seeded default
// account (migration 033 / getDefaultAccountId), so single-account callers that
// pass nothing behave byte-identically to the pre-V2 single-row world. The
// draft-time path (draft-prompt route) resolves the in-flight draft's account
// and passes it explicitly so a multi-mailbox appliance drafts in the right
// voice against the right history.

// STAQPRO-153: pull the last N sent_history rows for persona extraction.
// Joined to inbox_messages to grab the prompting subject/body so exemplars
// have the inbound side of each pair. Newest-first; cap at 500 to keep the
// extraction cost bounded on the Jetson. MBOX-352: scoped to one account.
export async function listSentHistoryForExtraction(
  limit = DEFAULT_EXTRACTION_LIMIT,
  accountId?: number,
): Promise<ExtractInput[]> {
  const safe = Math.min(Math.max(Math.trunc(limit) || DEFAULT_EXTRACTION_LIMIT, 1), 500);
  const acct = accountId ?? (await getDefaultAccountId());
  const db = getKysely();
  const rows = await db
    .selectFrom('sent_history as s')
    .leftJoin('inbox_messages as m', 's.inbox_message_id', 'm.id')
    .select([
      's.draft_sent as draft_sent',
      's.classification_category as classification_category',
      'm.subject as inbox_subject',
      'm.body as inbox_body',
      's.sent_at as sent_at',
    ])
    .where('s.account_id', '=', acct)
    .orderBy('s.sent_at', 'desc')
    .limit(safe)
    .execute();
  return rows.map((r) => ({
    draft_sent: r.draft_sent,
    classification_category: r.classification_category,
    inbox_subject: r.inbox_subject,
    inbox_body: r.inbox_body,
    sent_at: r.sent_at,
  }));
}

// MBOX-375 — pull reject feedback joined to its draft + inbound message for the
// reject_signals aggregator. draft_feedback / drafts / inbox_messages are NOT
// account-scoped (no account_id column), so this read is global — equivalent to
// account-scoped on the single live appliance. Newest-first, capped to keep the
// aggregation bounded. Sender is normalized here (matching queries-sender.ts) so
// the pure aggregator stays dependency-free.
const DEFAULT_REJECT_FEEDBACK_LIMIT = 1000;

export async function listRejectFeedbackForSignals(
  limit = DEFAULT_REJECT_FEEDBACK_LIMIT,
): Promise<RejectFeedbackInput[]> {
  const safe = Math.min(Math.max(Math.trunc(limit) || DEFAULT_REJECT_FEEDBACK_LIMIT, 1), 5000);
  const db = getKysely();
  const rows = await db
    .selectFrom('draft_feedback as df')
    .innerJoin('drafts as d', 'd.id', 'df.draft_id')
    .leftJoin('inbox_messages as m', 'm.draft_id', 'd.id')
    .select([
      'df.draft_id as draft_id',
      'df.reason_code as reason_code',
      'df.rejected_at as rejected_at',
      'd.classification_category as classification_category',
      'm.from_addr as from_addr',
      'm.subject as inbound_subject',
      'm.body as inbound_body',
    ])
    .orderBy('df.rejected_at', 'desc')
    .limit(safe)
    .execute();
  return rows.map((r) => ({
    draft_id: r.draft_id,
    reason_code: r.reason_code as RejectReasonCode,
    classification_category: r.classification_category,
    sender: r.from_addr ? normalizeSender(r.from_addr) || null : null,
    inbound_subject: r.inbound_subject,
    inbound_body: r.inbound_body,
    rejected_at: r.rejected_at,
  }));
}

export async function getPersona(
  accountId?: number,
  customerKey = 'default',
): Promise<Persona | null> {
  const acct = accountId ?? (await getDefaultAccountId());
  const db = getKysely();
  const row = await db
    .selectFrom('persona')
    .selectAll()
    .where('account_id', '=', acct)
    .where('customer_key', '=', customerKey)
    .executeTakeFirst();
  return (row as Persona | undefined) ?? null;
}

export async function upsertPersona(
  statistical: Record<string, unknown>,
  exemplars: Record<string, unknown>,
  sourceCount: number,
  accountId?: number,
  customerKey = 'default',
): Promise<Persona> {
  const acct = accountId ?? (await getDefaultAccountId());
  const db = getKysely();
  // pg accepts a JS object as a JSON/JSONB parameter and stringifies internally;
  // the JSON.stringify calls preserve the original behavior verbatim.
  const stat = JSON.stringify(statistical);
  const exem = JSON.stringify(exemplars);
  const row = await db
    .insertInto('persona')
    .values({
      account_id: acct,
      customer_key: customerKey,
      statistical_markers: sql`${stat}::jsonb`,
      category_exemplars: sql`${exem}::jsonb`,
      source_email_count: sourceCount,
      last_refreshed_at: sql<string>`NOW()`,
      updated_at: sql<string>`NOW()`,
    })
    // MBOX-352 — conflict target is the new composite unique
    // (account_id, customer_key); migration 035 replaced the global
    // UNIQUE(customer_key) so each account holds its own persona row.
    .onConflict((oc) =>
      oc.columns(['account_id', 'customer_key']).doUpdateSet((eb) => ({
        statistical_markers: eb.ref('excluded.statistical_markers'),
        category_exemplars: eb.ref('excluded.category_exemplars'),
        source_email_count: eb.ref('excluded.source_email_count'),
        last_refreshed_at: eb.ref('excluded.last_refreshed_at'),
        updated_at: sql<string>`NOW()`,
      })),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as Persona;
}

// MBOX-162 P5a (Tuning · Style tab) — merge a PARTIAL set of statistical_markers
// into the existing persona row, preserving every marker key the caller didn't
// touch plus category_exemplars / source_email_count / last_refreshed_at. The
// Style tab owns only a handful of voice knobs; it must not clobber extraction-
// derived markers or the exemplar few-shots (which upsertPersona would replace).
//
// Read-modify-write: the merge happens in JS against the current row, then the
// already-merged object is written. Last-write-wins across concurrent editors —
// acceptable on the single-operator appliance (no multi-writer contention).
// Notably does NOT bump last_refreshed_at (that's the extraction timestamp).
export async function mergePersonaMarkers(
  partial: Record<string, unknown>,
  accountId?: number,
  customerKey = 'default',
): Promise<Persona> {
  const acct = accountId ?? (await getDefaultAccountId());
  const current = await getPersona(acct, customerKey);
  const mergedMarkers = { ...(current?.statistical_markers ?? {}), ...partial };
  const exemplars = current?.category_exemplars ?? {};

  const db = getKysely();
  const stat = JSON.stringify(mergedMarkers);
  const exem = JSON.stringify(exemplars);
  const row = await db
    .insertInto('persona')
    .values({
      account_id: acct,
      customer_key: customerKey,
      statistical_markers: sql`${stat}::jsonb`,
      category_exemplars: sql`${exem}::jsonb`,
      source_email_count: current?.source_email_count ?? 0,
      // Preserve the extraction timestamp — a Style edit is not a re-extraction.
      last_refreshed_at: current?.last_refreshed_at ?? null,
      updated_at: sql<string>`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(['account_id', 'customer_key']).doUpdateSet((eb) => ({
        // Only the markers (the merged object) and updated_at change; the other
        // columns in excluded equal the current row, so updating them is a no-op.
        statistical_markers: eb.ref('excluded.statistical_markers'),
        updated_at: sql<string>`NOW()`,
      })),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as Persona;
}
