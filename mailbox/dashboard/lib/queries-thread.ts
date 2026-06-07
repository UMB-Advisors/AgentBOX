import { getKysely } from '@/lib/db';
import type { ThreadMessage } from '@/lib/types';

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

  return [...inbound, ...outbound].sort((a, b) => a.at.localeCompare(b.at));
}
