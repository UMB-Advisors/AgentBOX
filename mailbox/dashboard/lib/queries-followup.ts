import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import { FOLLOWUP_CATEGORIES, followupThresholdHours } from '@/lib/followup';
import type { ClassificationCategory } from '@/lib/types';

// MBOX-377 — follow-up / no-reply detection. Surfaces outbound replies the
// appliance SENT whose thread has gone quiet: no inbound has arrived since our
// send, past the per-category follow-up threshold (lib/followup.ts). This is the
// outbound-thread-liveness surface — distinct from the daily digest's pending
// queue (MBOX-132) and from Gmail inbox snooze (MBOX-369).
//
// Set-wise, no N+1: one query computes the whole "awaiting reply" set. The
// operator-owns-thread guard (MBOX-142 / lib/classification/thread-ownership.ts)
// is applied by the CALLER over the bounded result (see getDigestPayload) — it
// does per-thread DB work, so we keep it out of this set-wise query and off the
// pure-detection test path.
//
// "Latest send per (account, thread)" is the unit: a thread where we sent twice
// is judged on the most recent send (DISTINCT ON). A thread we already followed
// up on is therefore re-clocked from the follow-up, not the original.

export interface AwaitingReplyItem {
  thread_id: string;
  // Who we're waiting on (the recipient of our last send on the thread).
  to_addr: string;
  subject: string | null;
  category: ClassificationCategory;
  // ISO-8601 of our most recent send on the thread.
  sent_at: string;
  // Hours since that send, rounded to one decimal (display).
  age_hours: number;
  // The draft that produced the send — lets the surface deep-link the thread.
  draft_id: number;
  account_id: number;
}

export interface AwaitingReplyOptions {
  // Scope to one inbox (MBOX-360). Omitted → all accounts (the digest view).
  accountId?: number;
  limit?: number;
  // Injected for tests; defaults to process.env (follow-up thresholds).
  env?: Record<string, string | undefined>;
}

const DEFAULT_LIMIT = 25;

export async function getAwaitingReply(
  opts: AwaitingReplyOptions = {},
): Promise<AwaitingReplyItem[]> {
  const env = opts.env ?? process.env;
  const limit = Math.min(
    Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
    200,
  );
  const db = getKysely();

  // Per-category threshold (hours) as a SQL CASE, resolved from env in TS so the
  // rule SoT stays in lib/followup.ts. ELSE covers any category not in the
  // tracked set (defensive; spam_marketing is excluded by the WHERE below).
  // The THEN/ELSE hours are emitted as numeric LITERALS (sql.lit), not bound
  // params: a param would type as text → `numeric >= text` at the comparison.
  // They are trusted integers from our own resolver, never user input.
  const thresholdCase = sql.join(
    FOLLOWUP_CATEGORIES.map((c) => sql`WHEN ${c} THEN ${sql.lit(followupThresholdHours(c, env))}`),
    sql` `,
  );
  const defaultHours = sql.lit(followupThresholdHours(undefined, env));

  const accountFilter =
    opts.accountId !== undefined ? sql`AND sh.account_id = ${opts.accountId}` : sql``;

  const result = await sql<{
    thread_id: string;
    to_addr: string;
    subject: string | null;
    category: ClassificationCategory;
    sent_at: string;
    age_hours: number | string;
    draft_id: number;
    account_id: number;
  }>`
    WITH latest_send AS (
      SELECT DISTINCT ON (sh.account_id, sh.thread_id)
        sh.thread_id                AS thread_id,
        sh.to_addr                  AS to_addr,
        sh.subject                  AS subject,
        sh.classification_category  AS category,
        sh.sent_at                  AS sent_at,
        sh.draft_id                 AS draft_id,
        sh.account_id               AS account_id
      FROM mailbox.sent_history sh
      WHERE sh.thread_id IS NOT NULL
        AND sh.classification_category <> 'spam_marketing'
        ${accountFilter}
      ORDER BY sh.account_id, sh.thread_id, sh.sent_at DESC
    )
    SELECT
      l.thread_id,
      l.to_addr,
      l.subject,
      l.category,
      l.sent_at::text AS sent_at,
      EXTRACT(EPOCH FROM (NOW() - l.sent_at)) / 3600.0 AS age_hours,
      l.draft_id,
      l.account_id
    FROM latest_send l
    WHERE NOT EXISTS (
      SELECT 1
      FROM mailbox.inbox_messages im
      WHERE im.thread_id = l.thread_id
        AND im.account_id = l.account_id
        AND im.received_at IS NOT NULL
        AND im.received_at > l.sent_at
    )
    AND EXTRACT(EPOCH FROM (NOW() - l.sent_at)) / 3600.0
        >= (CASE l.category ${thresholdCase} ELSE ${defaultHours} END)
    ORDER BY l.sent_at ASC
    LIMIT ${limit}
  `.execute(db);

  return result.rows.map((r) => ({
    thread_id: r.thread_id,
    to_addr: r.to_addr,
    subject: r.subject,
    category: r.category,
    sent_at: r.sent_at,
    age_hours: Math.round(Math.max(Number(r.age_hours), 0) * 10) / 10,
    draft_id: r.draft_id,
    account_id: r.account_id,
  }));
}
