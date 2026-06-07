// dashboard/lib/queries-chat-stats.ts
//
// MBOX-307 — appliance-stats context for the /dashboard/chat assistant (epic
// MBOX-282). Operational/aggregate questions ("how many emails have we
// ingested," "who do we email most," "what do we email about") can't be served
// by top-k RAG retrieval over individual messages — they fall below the
// relevance floor and the 4B model confabulates a (partly false) self-
// description. The fix is to compute the appliance's REAL numbers with cheap
// aggregate SQL and inject them as a facts block into the chat context (see
// lib/chat/assemble.ts:renderApplianceStatsBlock). Decision: stats-context
// injection, NOT 4B function-calling (unreliable tool-call JSON on a 4B).
//
// LOCAL-ONLY (DR-53): every aggregate here reads the local Postgres `mailbox`
// schema. Nothing is sent to or sourced from a cloud provider.
//
// Kept cheap and bounded: a handful of indexed aggregates, top-N capped at
// STATS_TOP_N, no full-table scans of message bodies. The rendered block is
// sized for the 4096-ctx local model (DR-18).

import { sql } from 'kysely';
import { getKysely } from '@/lib/db';

// Top-N cap for sender/recipient leaderboards. Keep small — the rendered block
// must stay within the 4096-ctx budget alongside history + RAG excerpts.
export const STATS_TOP_N = 5;

export interface SenderCount {
  addr: string;
  count: number;
}

export interface CategoryCount {
  category: string;
  count: number;
}

export interface ApplianceStatsContext {
  inbound: {
    total: number;
    last_24h: number;
    last_7d: number;
    last_30d: number;
    earliest_received_at: string | null;
    latest_received_at: string | null;
  };
  // Counts per classification (inbox_messages.classification denorm). Sorted
  // desc by count. Excludes NULL/unclassified rows.
  categories: CategoryCount[];
  // Top inbound senders by message volume (inbox_messages.from_addr).
  top_senders: SenderCount[];
  // Top outbound recipients by message volume (sent_history.to_addr).
  top_recipients: SenderCount[];
  // Draft/queue state counts (mailbox.drafts.status).
  queue: {
    pending: number;
    approved: number;
    sent: number;
    rejected: number;
  };
}

// Postgres count()/aggregate values come back as strings under the
// numeric-as-string convention (see CLAUDE.md — pg type-parser overrides /
// kysely-codegen --numeric-parser string). Coerce to a JS number once at the
// boundary; empty tables yield '0' (or null for max/min), never undefined.
function n(v: string | number | bigint | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}

/**
 * Compute the appliance's live operational stats as a compact object. Cheap
 * aggregate queries over existing tables — NO migration, read-only. Empty
 * tables degrade to zeros / nulls, never throw on no-data.
 *
 * IO layer: this touches the DB, so it lives here (not in the pure assembler).
 * The chat orchestration calls it alongside retrieval and passes the result
 * into assembleChatMessages.
 */
export async function getApplianceStatsContext(): Promise<ApplianceStatsContext> {
  const db = getKysely();

  // 1. Inbound totals + windowed counts + min/max received_at, in one row.
  //    received_at can be NULL for never-stamped rows; COUNT(*) still counts
  //    them, the windowed FILTERs simply exclude NULL received_at.
  const inboundRow = await db
    .selectFrom('inbox_messages')
    .select((eb) => [
      eb.fn.countAll<string>().as('total'),
      eb.fn.min('received_at').as('earliest'),
      eb.fn.max('received_at').as('latest'),
      sql<string>`count(*) filter (where received_at > now() - interval '24 hours')`.as('h24'),
      sql<string>`count(*) filter (where received_at > now() - interval '7 days')`.as('d7'),
      sql<string>`count(*) filter (where received_at > now() - interval '30 days')`.as('d30'),
    ])
    .executeTakeFirst();

  // 2. Category breakdown from the inbox_messages.classification denorm (the
  //    message-level snapshot of the latest classification — see CLAUDE.md).
  const categoryRows = await db
    .selectFrom('inbox_messages')
    .select((eb) => ['classification', eb.fn.countAll<string>().as('count')])
    .where('classification', 'is not', null)
    .groupBy('classification')
    .orderBy('count', 'desc')
    .execute();

  // 3. Top inbound senders by volume.
  const senderRows = await db
    .selectFrom('inbox_messages')
    .select((eb) => ['from_addr', eb.fn.countAll<string>().as('count')])
    .where('from_addr', 'is not', null)
    .groupBy('from_addr')
    .orderBy('count', 'desc')
    .limit(STATS_TOP_N)
    .execute();

  // 4. Top outbound recipients by volume. sent_history.to_addr is NOT NULL.
  const recipientRows = await db
    .selectFrom('sent_history')
    .select((eb) => ['to_addr', eb.fn.countAll<string>().as('count')])
    .groupBy('to_addr')
    .orderBy('count', 'desc')
    .limit(STATS_TOP_N)
    .execute();

  // 5. Draft/queue state counts. One grouped scan; map onto the four buckets
  //    the chat surface cares about. Other statuses (awaiting_cloud, edited)
  //    are intentionally not surfaced — the operator question is queue depth.
  const statusRows = await db
    .selectFrom('drafts')
    .select((eb) => ['status', eb.fn.countAll<string>().as('count')])
    .groupBy('status')
    .execute();

  const statusMap = new Map<string, number>();
  for (const r of statusRows) statusMap.set(r.status, n(r.count));

  return {
    inbound: {
      total: n(inboundRow?.total),
      last_24h: n(inboundRow?.h24),
      last_7d: n(inboundRow?.d7),
      last_30d: n(inboundRow?.d30),
      earliest_received_at: inboundRow?.earliest ?? null,
      latest_received_at: inboundRow?.latest ?? null,
    },
    categories: categoryRows
      // classification is filtered NOT NULL above; the codegen type is still
      // `string | null`, so narrow defensively.
      .filter((r): r is typeof r & { classification: string } => r.classification !== null)
      .map((r) => ({ category: r.classification, count: n(r.count) })),
    top_senders: senderRows
      .filter((r): r is typeof r & { from_addr: string } => r.from_addr !== null)
      .map((r) => ({ addr: r.from_addr, count: n(r.count) })),
    top_recipients: recipientRows.map((r) => ({ addr: r.to_addr, count: n(r.count) })),
    queue: {
      pending: statusMap.get('pending') ?? 0,
      approved: statusMap.get('approved') ?? 0,
      sent: statusMap.get('sent') ?? 0,
      rejected: statusMap.get('rejected') ?? 0,
    },
  };
}
