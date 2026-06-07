import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { operatorOwnsThread } from '@/lib/classification/thread-ownership';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// UMB-154 — operator-owns-thread guard.
// Covers the live draft-158 case: jt@heronlabsinc.com replied to
// shabegsh@gmail.com within the last 24h; when shabegsh sent "Got it - thanks!"
// the appliance should NOT draft a reply because the operator already has the
// thread.

// ─── Pure-logic cases (run without DB) ──────────────────────────────────────

describe('operatorOwnsThread — pure logic (no DB)', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns owned:false, reason:no_thread_id when thread_id is null', async () => {
    const result = await operatorOwnsThread({ thread_id: null });
    expect(result.owned).toBe(false);
    expect(result.reason).toBe('no_thread_id');
  });

  it('returns owned:false, reason:no_thread_id when thread_id is empty string', async () => {
    const result = await operatorOwnsThread({ thread_id: '' });
    expect(result.owned).toBe(false);
    expect(result.reason).toBe('no_thread_id');
  });

  it('returns owned:false, reason:disabled when kill switch is set', async () => {
    process.env.OPERATOR_THREAD_GUARD_DISABLE = '1';
    const result = await operatorOwnsThread({ thread_id: 'thread-abc' });
    expect(result.owned).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('does not honor kill switch with value 0', async () => {
    process.env.OPERATOR_THREAD_GUARD_DISABLE = '0';
    // Without DB, will either succeed or return db_unavailable — either way,
    // the kill switch must NOT return 'disabled'.
    const result = await operatorOwnsThread({ thread_id: 'thread-xyz' });
    expect(result.reason).not.toBe('disabled');
  });
});

// ─── DB-backed cases ─────────────────────────────────────────────────────────

const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('operatorOwnsThread — DB-backed', () => {
  // Lazy pool: only resolved when tests actually run (getTestPool() throws
  // if HAS_DB is false, but describe.skip still executes the callback body).
  const pool = () => getTestPool();
  // Unique tag per test run to avoid cross-test contamination
  let tag: string;

  beforeEach(() => {
    tag = `thr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  // Helper: insert a sent_history row simulating an operator outbound
  async function insertSentRow(opts: {
    thread_id: string;
    from_addr: string;
    to_addr: string;
    sent_at: Date;
  }) {
    const msgId = `sent-${Math.random().toString(36).slice(2, 12)}`;
    await pool().query(
      `INSERT INTO mailbox.sent_history
         (message_id, thread_id, from_addr, to_addr, subject, draft_sent,
          draft_source, classification_category, classification_confidence, sent_at)
       VALUES ($1, $2, $3, $4, 'Re: test', 'body text',
               'cloud', 'follow_up', 0.9, $5)`,
      [msgId, opts.thread_id, opts.from_addr, opts.to_addr, opts.sent_at],
    );
    return msgId;
  }

  // Helper: insert an inbox_messages row (simulates operator-domain msg in inbox)
  async function insertInboxRow(opts: {
    thread_id: string;
    from_addr: string;
    to_addr: string;
    received_at: Date;
  }) {
    const msgId = `inbox-${Math.random().toString(36).slice(2, 12)}`;
    await pool().query(
      `INSERT INTO mailbox.inbox_messages
         (message_id, thread_id, from_addr, to_addr, subject, body, received_at)
       VALUES ($1, $2, $3, $4, 'test subject', 'test body', $5)`,
      [msgId, opts.thread_id, opts.from_addr, opts.to_addr, opts.received_at],
    );
    return msgId;
  }

  // Cleanup by tag pattern
  afterEach(async () => {
    if (!tag) return;
    await pool().query(`DELETE FROM mailbox.sent_history WHERE thread_id LIKE $1`, [`${tag}%`]);
    await pool().query(`DELETE FROM mailbox.inbox_messages WHERE thread_id LIKE $1`, [`${tag}%`]);
  });

  it('owned:true when operator replied 1h ago (draft-158 case)', async () => {
    const threadId = `${tag}-active`;
    const now = new Date('2026-05-20T10:00:00Z');
    const oneHourAgo = new Date('2026-05-20T09:00:00Z');

    await insertSentRow({
      thread_id: threadId,
      from_addr: 'jt@heronlabsinc.com',
      to_addr: 'shabegsh@gmail.com',
      sent_at: oneHourAgo,
    });

    const result = await operatorOwnsThread({ thread_id: threadId, now });

    expect(result.owned).toBe(true);
    expect(result.reason).toBe('operator_owns_thread');
    expect(result.last_operator_reply_at).toBeDefined();
  });

  it('owned:false when last operator reply was 26h ago (lapsed thread)', async () => {
    const threadId = `${tag}-lapsed`;
    const now = new Date('2026-05-20T10:00:00Z');
    const twentySixHoursAgo = new Date('2026-05-19T08:00:00Z');

    await insertSentRow({
      thread_id: threadId,
      from_addr: 'jt@heronlabsinc.com',
      to_addr: 'shabegsh@gmail.com',
      sent_at: twentySixHoursAgo,
    });

    const result = await operatorOwnsThread({ thread_id: threadId, now });

    expect(result.owned).toBe(false);
    expect(result.reason).toBe('lapsed');
  });

  it('owned:false when only counterparty messages exist (operator never replied)', async () => {
    const threadId = `${tag}-untouched`;
    const now = new Date('2026-05-20T10:00:00Z');

    await insertInboxRow({
      thread_id: threadId,
      from_addr: 'customer@gmail.com',
      to_addr: 'jt@heronlabsinc.com',
      received_at: new Date('2026-05-20T09:00:00Z'),
    });

    const result = await operatorOwnsThread({ thread_id: threadId, now });

    expect(result.owned).toBe(false);
    expect(result.reason).toBe('no_operator_msg');
  });

  it('owned:true when operator message is in inbox_messages (self-loop that landed as inbound)', async () => {
    const threadId = `${tag}-inbox-op`;
    const now = new Date('2026-05-20T10:00:00Z');
    const twoHoursAgo = new Date('2026-05-20T08:00:00Z');

    // Operator message in inbox (e.g. a CC'd copy of the operator's reply)
    await insertInboxRow({
      thread_id: threadId,
      from_addr: 'jt@heronlabsinc.com',
      to_addr: 'shabegsh@gmail.com',
      received_at: twoHoursAgo,
    });

    const result = await operatorOwnsThread({ thread_id: threadId, now });

    expect(result.owned).toBe(true);
    expect(result.reason).toBe('operator_owns_thread');
  });

  it('owned:true uses any operator-domain address, not just the inbound recipient', async () => {
    const threadId = `${tag}-any-op`;
    const now = new Date('2026-05-20T10:00:00Z');
    const thirtyMinutesAgo = new Date('2026-05-20T09:30:00Z');

    // A different operator-domain address replied (nicky@, not jt@)
    await insertSentRow({
      thread_id: threadId,
      from_addr: 'nicky@heronlabsinc.com',
      to_addr: 'shabegsh@gmail.com',
      sent_at: thirtyMinutesAgo,
    });

    const result = await operatorOwnsThread({ thread_id: threadId, now });

    expect(result.owned).toBe(true);
    expect(result.reason).toBe('operator_owns_thread');
  });

  it('owned:false when only a role-inbox exception (sales@) replied — appliance drafts FOR it', async () => {
    // UMB-154 / Linus review fix: OPERATOR_INBOX_EXCEPTIONS addresses are the
    // inboxes the appliance drafts for, so a reply from them must NOT mark the
    // thread "owned" (mirrors precheckSelfLoop). Otherwise a sales@ reply would
    // suppress the very drafts the appliance exists to produce.
    const threadId = `${tag}-role-inbox`;
    const now = new Date('2026-05-20T10:00:00Z');
    const oneHourAgo = new Date('2026-05-20T09:00:00Z');

    await insertSentRow({
      thread_id: threadId,
      from_addr: 'sales@heronlabsinc.com', // default OPERATOR_INBOX_EXCEPTIONS member
      to_addr: 'prospect@gmail.com',
      sent_at: oneHourAgo,
    });

    const result = await operatorOwnsThread({ thread_id: threadId, now });

    expect(result.owned).toBe(false);
    expect(result.reason).toBe('no_operator_msg');
  });

  it('respects OPERATOR_THREAD_WINDOW_HOURS env override', async () => {
    const threadId = `${tag}-window`;
    const now = new Date('2026-05-20T10:00:00Z');
    // 2h ago — inside default 24h window but outside a 1h window
    const twoHoursAgo = new Date('2026-05-20T08:00:00Z');

    await insertSentRow({
      thread_id: threadId,
      from_addr: 'jt@heronlabsinc.com',
      to_addr: 'shabegsh@gmail.com',
      sent_at: twoHoursAgo,
    });

    // Default window (24h) → owned
    const defaultResult = await operatorOwnsThread({ thread_id: threadId, now });
    expect(defaultResult.owned).toBe(true);

    // Narrow window (1h) → lapsed
    process.env.OPERATOR_THREAD_WINDOW_HOURS = '1';
    const narrowResult = await operatorOwnsThread({ thread_id: threadId, now });
    expect(narrowResult.owned).toBe(false);
    expect(narrowResult.reason).toBe('lapsed');

    delete process.env.OPERATOR_THREAD_WINDOW_HOURS;
  });
});
