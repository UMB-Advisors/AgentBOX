import { afterAll, describe, expect, it } from 'vitest';
import { getThreadHistory, getThreadHistoryBatch } from '@/lib/queries-thread';
import type { ThreadMessage } from '@/lib/types';
import {
  closeTestPool,
  deleteSeededDraft,
  getTestPool,
  HAS_DB,
  type SeededDraft,
  seedDraft,
} from '../helpers/db';

// MBOX-perf: batch thread-history fetch — regression guard.
// DB-backed: skips without TEST_POSTGRES_URL (same gate as other route suites).

const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('getThreadHistoryBatch — real Postgres', () => {
  const seeded: SeededDraft[] = [];

  afterAll(async () => {
    // Clean up seeded drafts in reverse order (drafts before inbox rows)
    for (const s of seeded) {
      await deleteSeededDraft(s);
    }
    await closeTestPool();
  });

  // Helpers to insert thread rows directly (seedDraft does not set thread_id)
  async function setThreadId(inboxMessageId: number, threadId: string): Promise<void> {
    const pool = getTestPool();
    await pool.query('UPDATE mailbox.inbox_messages SET thread_id = $1 WHERE id = $2', [
      threadId,
      inboxMessageId,
    ]);
  }

  async function insertInboundRow(
    threadId: string,
    fromAddr: string,
    sentAt: string,
  ): Promise<void> {
    const pool = getTestPool();
    const tag = `hist-in-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await pool.query(
      `INSERT INTO mailbox.inbox_messages
         (message_id, from_addr, to_addr, subject, body, received_at, thread_id)
       VALUES ($1, $2, 'op@example.com', 'Re: history', 'prior inbound body', $3, $4)`,
      [tag, fromAddr, sentAt, threadId],
    );
  }

  async function insertOutboundRow(threadId: string, sentAt: string): Promise<void> {
    const pool = getTestPool();
    await pool.query(
      `INSERT INTO mailbox.sent_history
         (from_addr, to_addr, subject, body_text, sent_at, thread_id,
          classification_category, classification_confidence,
          draft_sent, draft_source)
       VALUES ('op@example.com', 'sender@example.com', 'Re: history',
               'prior sent body', $1, $2,
               'reorder', 0.9, 'prior sent body', 'local')`,
      [sentAt, threadId],
    );
  }

  it('1. equivalence: batch returns same per-thread arrays as per-thread calls', async () => {
    const threadA = `test-batch-thread-A-${Date.now()}`;
    const threadB = `test-batch-thread-B-${Date.now()}`;

    // Seed two drafts (inbox_messages + drafts rows)
    const draftA = await seedDraft({ status: 'pending' });
    const draftB = await seedDraft({ status: 'pending' });
    seeded.push(draftA, draftB);

    // Assign thread ids
    await setThreadId(draftA.inboxMessageId, threadA);
    await setThreadId(draftB.inboxMessageId, threadB);

    // Add prior history rows to each thread
    await insertInboundRow(threadA, 'customer-a@example.com', '2026-01-01T10:00:00Z');
    await insertOutboundRow(threadA, '2026-01-01T11:00:00Z');
    await insertInboundRow(threadB, 'customer-b@example.com', '2026-01-02T09:00:00Z');

    // Per-thread results (existing function)
    const singleA = await getThreadHistory(threadA, draftA.inboxMessageId);
    const singleB = await getThreadHistory(threadB, draftB.inboxMessageId);

    // Batch result — returns array indexed by input order
    const histories = await getThreadHistoryBatch([
      { threadId: threadA, excludeInboxMessageId: draftA.inboxMessageId },
      { threadId: threadB, excludeInboxMessageId: draftB.inboxMessageId },
    ]);

    // Equivalence check: index 0 = threadA, index 1 = threadB
    expect(histories[0]).toEqual(singleA);
    expect(histories[1]).toEqual(singleB);
  });

  it('2. null/empty threadId items return [] and cause no query errors', async () => {
    const draftNull = await seedDraft({ status: 'pending' });
    seeded.push(draftNull);
    // Do NOT set thread_id — it remains null

    const histories = await getThreadHistoryBatch([
      { threadId: null, excludeInboxMessageId: draftNull.inboxMessageId },
      { threadId: '', excludeInboxMessageId: 99999 },
    ]);

    // Both items have no valid thread id — each returns []
    expect(histories).toHaveLength(2);
    expect(histories[0]).toEqual([]);
    expect(histories[1]).toEqual([]);
  });

  it('3. excluded message id does not appear in its thread history', async () => {
    const threadC = `test-batch-thread-C-${Date.now()}`;

    const draftC = await seedDraft({ status: 'pending' });
    seeded.push(draftC);
    await setThreadId(draftC.inboxMessageId, threadC);

    // Add an inbound row (not the draft's own inbox row) to the thread
    await insertInboundRow(threadC, 'other@example.com', '2026-01-03T08:00:00Z');

    const histories = await getThreadHistoryBatch([
      { threadId: threadC, excludeInboxMessageId: draftC.inboxMessageId },
    ]);

    const history = histories[0];

    // The draft's own inbox message must not appear in history
    const excludedPresent = history.some(
      (m: ThreadMessage) => m.direction === 'inbound' && m.id === draftC.inboxMessageId,
    );
    expect(excludedPresent).toBe(false);

    // The other inbound row IS present
    expect(history.some((m) => m.direction === 'inbound')).toBe(true);
  });

  it('4. shared thread: two drafts each exclude only their own inbox message', async () => {
    // Regression test for the review finding: when two drafts share the same
    // thread, the batch must not union their exclude ids — each draft's history
    // must contain the other draft's inbox message, not its own.
    const threadD = `test-batch-thread-D-${Date.now()}`;

    // Two drafts on the same thread
    const draftD1 = await seedDraft({ status: 'pending' });
    const draftD2 = await seedDraft({ status: 'pending' });
    seeded.push(draftD1, draftD2);
    await setThreadId(draftD1.inboxMessageId, threadD);
    await setThreadId(draftD2.inboxMessageId, threadD);

    // A sent_history row so the thread isn't empty on the outbound side
    await insertOutboundRow(threadD, '2026-01-04T09:00:00Z');

    // Per-item expectations via the single-item function
    const singleD1 = await getThreadHistory(threadD, draftD1.inboxMessageId);
    const singleD2 = await getThreadHistory(threadD, draftD2.inboxMessageId);

    const histories = await getThreadHistoryBatch([
      { threadId: threadD, excludeInboxMessageId: draftD1.inboxMessageId },
      { threadId: threadD, excludeInboxMessageId: draftD2.inboxMessageId },
    ]);

    // Each item's result must match getThreadHistory with that item's own exclude id
    expect(histories[0]).toEqual(singleD1);
    expect(histories[1]).toEqual(singleD2);

    // Explicitly: draft1's history contains draft2's inbox message (and vice versa)
    expect(
      histories[0].some((m) => m.direction === 'inbound' && m.id === draftD2.inboxMessageId),
    ).toBe(true);
    expect(
      histories[1].some((m) => m.direction === 'inbound' && m.id === draftD1.inboxMessageId),
    ).toBe(true);

    // And neither contains its own inbox message
    expect(
      histories[0].some((m) => m.direction === 'inbound' && m.id === draftD1.inboxMessageId),
    ).toBe(false);
    expect(
      histories[1].some((m) => m.direction === 'inbound' && m.id === draftD2.inboxMessageId),
    ).toBe(false);
  });
});
