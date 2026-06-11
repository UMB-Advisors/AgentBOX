import { getKysely } from '@/lib/db';
import type { ThreadMessage } from '@/lib/types';

function sortByAt(msgs: ThreadMessage[]): ThreadMessage[] {
  return msgs.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Fetch all prior messages on a Gmail thread (both inbound and outbound),
 * excluding the current inbound message. Returns [] when threadId is null/empty.
 *
 * Two parallel SELECTs (kysely typed) merged + sorted in JS rather than a
 * UNION ALL — column shapes differ (body vs body_text, received_at vs sent_at)
 * and the JS merge keeps both sides strongly typed without resorting to
 * sql.raw or a discriminated UNION via column aliasing.
 *
 * Thread sizes cap at ~14 locally (verified on thread_id 19c8bd2848bf524b);
 * no pagination needed.
 */
export async function getThreadHistory(
  threadId: string | null,
  excludeInboxMessageId: number,
): Promise<ThreadMessage[]> {
  if (!threadId) return [];
  const db = getKysely();

  const [inboundRows, outboundRows] = await Promise.all([
    db
      .selectFrom('inbox_messages')
      .where('thread_id', '=', threadId)
      .where('id', '<>', excludeInboxMessageId)
      .select(['id', 'from_addr', 'to_addr', 'subject', 'body', 'received_at'])
      .execute(),
    db
      .selectFrom('sent_history')
      .where('thread_id', '=', threadId)
      .select(['id', 'from_addr', 'to_addr', 'subject', 'body_text', 'sent_at'])
      .execute(),
  ]);

  const inbound: ThreadMessage[] = inboundRows
    .filter((r) => r.received_at !== null)
    .map((r) => ({
      direction: 'inbound' as const,
      id: r.id,
      from_addr: r.from_addr,
      to_addr: r.to_addr,
      subject: r.subject,
      body: r.body,
      at: r.received_at as string,
    }));

  const outbound: ThreadMessage[] = outboundRows.map((r) => ({
    direction: 'outbound' as const,
    id: Number(r.id), // Int8 → number; thread <= ~14 rows so safe
    from_addr: r.from_addr,
    to_addr: r.to_addr,
    subject: r.subject,
    body: r.body_text,
    at: r.sent_at,
  }));

  return sortByAt([...inbound, ...outbound]);
}

// ── Batch variant (used by listDrafts / getQueueWithUrgency) ─────────────────

export interface ThreadHistoryItem {
  threadId: string | null;
  excludeInboxMessageId: number;
}

/**
 * Batch version of getThreadHistory for queue list paths.
 *
 * Issues exactly TWO queries total (one per table) using `thread_id IN (...)`,
 * then groups all rows by thread_id in JS WITHOUT any exclusion — collapsing
 * the N+1 fan-out that listDrafts previously produced (2 queries × N drafts).
 *
 * Returns one ThreadMessage[] per input item, in input order. Items with a
 * null/empty threadId return []. Exclusion is applied per input item: only
 * inbound messages whose id equals that item's excludeInboxMessageId are
 * filtered out; outbound messages are never excluded. This preserves correct
 * behavior when two drafts share the same thread — each draft's history
 * excludes only its own inbox message, not the other draft's.
 */
export async function getThreadHistoryBatch(
  items: ThreadHistoryItem[],
): Promise<ThreadMessage[][]> {
  const ids = [...new Set(items.flatMap((i) => (i.threadId ? [i.threadId] : [])))];
  if (ids.length === 0) return items.map(() => []);

  const db = getKysely();

  const [inboundRows, outboundRows] = await Promise.all([
    db
      .selectFrom('inbox_messages')
      .where('thread_id', 'in', ids)
      .select(['id', 'from_addr', 'to_addr', 'subject', 'body', 'received_at', 'thread_id'])
      .execute(),
    db
      .selectFrom('sent_history')
      .where('thread_id', 'in', ids)
      .select(['id', 'from_addr', 'to_addr', 'subject', 'body_text', 'sent_at', 'thread_id'])
      .execute(),
  ]);

  // Group full (unfiltered) messages by thread_id
  const grouped = new Map<string, ThreadMessage[]>();

  for (const r of inboundRows) {
    const tid = r.thread_id;
    if (!tid) continue;
    if (r.received_at === null) continue;
    const msg: ThreadMessage = {
      direction: 'inbound' as const,
      id: r.id,
      from_addr: r.from_addr,
      to_addr: r.to_addr,
      subject: r.subject,
      body: r.body,
      at: r.received_at as string,
    };
    let arr = grouped.get(tid);
    if (!arr) {
      arr = [];
      grouped.set(tid, arr);
    }
    arr.push(msg);
  }

  for (const r of outboundRows) {
    const tid = r.thread_id;
    if (!tid) continue;
    const msg: ThreadMessage = {
      direction: 'outbound' as const,
      id: Number(r.id), // Int8 → number; thread <= ~14 rows so safe
      from_addr: r.from_addr,
      to_addr: r.to_addr,
      subject: r.subject,
      body: r.body_text,
      at: r.sent_at,
    };
    let arr = grouped.get(tid);
    if (!arr) {
      arr = [];
      grouped.set(tid, arr);
    }
    arr.push(msg);
  }

  // Sort each thread's full list once
  for (const [tid, msgs] of grouped) {
    grouped.set(tid, sortByAt(msgs));
  }

  // Per input item: take the sorted thread list and exclude only this item's
  // own inbox message (outbound messages are never excluded)
  return items.map((item) => {
    if (!item.threadId) return [];
    const full = grouped.get(item.threadId) ?? [];
    return full.filter((m) => !(m.direction === 'inbound' && m.id === item.excludeInboxMessageId));
  });
}
