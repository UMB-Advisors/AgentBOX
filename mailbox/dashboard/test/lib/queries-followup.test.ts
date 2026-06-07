import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAwaitingReply } from '@/lib/queries-followup';
import { closeTestPool, getTestPool, HAS_DB, seedDraft } from '../helpers/db';

// MBOX-377 — DB test for the awaiting-reply detection query. Seeds sent_history
// + inbox_messages directly (the only place sent_history rows are minted outside
// the archive trigger) and asserts: a stale no-reply send surfaces, a reply
// since our send clears it, a too-young send is excluded, the latest send per
// thread is the unit, the per-category threshold env is honored, and the
// account filter scopes. Skips cleanly without TEST_POSTGRES_URL.

const dbDescribe = HAS_DB ? describe : describe.skip;
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Pin inquiry's threshold to 24h so the seed timings below are deterministic
// regardless of the compose defaults.
const ENV = { FOLLOWUP_AGE_HOURS_INQUIRY: '24' };

dbDescribe('getAwaitingReply — real Postgres', () => {
  let accountId: number;
  let draftId: number;
  let inboxMessageId: number;

  // Insert a sent_history row on the test account, sent `hoursAgo` hours ago.
  // Reuses the one seeded draft/inbox for the FKs (message_id left null so the
  // partial unique dedup index is not engaged).
  async function insertSend(threadId: string, hoursAgo: number) {
    await getTestPool().query(
      `INSERT INTO mailbox.sent_history
         (account_id, draft_id, inbox_message_id, from_addr, to_addr, thread_id, subject,
          draft_sent, draft_source, classification_category, classification_confidence, sent_at)
       VALUES ($1, $2, $3, 'op@example.com', 'buyer@acme.com', $4, 'Re: your quote',
               'sure, here you go', 'local', 'inquiry', 0.9, NOW() - ($5 || ' hours')::interval)`,
      [accountId, draftId, inboxMessageId, threadId, String(hoursAgo)],
    );
  }

  async function insertInbound(threadId: string, hoursAgo: number) {
    await getTestPool().query(
      `INSERT INTO mailbox.inbox_messages (account_id, message_id, thread_id, from_addr, received_at)
       VALUES ($1, $2, $3, 'buyer@acme.com', NOW() - ($4 || ' hours')::interval)`,
      [accountId, `fu-in-${stamp}-${threadId}`, threadId, String(hoursAgo)],
    );
  }

  beforeAll(async () => {
    const pool = getTestPool();
    const r = await pool.query<{ id: number }>(
      `INSERT INTO mailbox.accounts (email_address, is_default, provider, provider_config)
       VALUES ($1, false, 'gmail', '{}'::jsonb) RETURNING id`,
      [`fu-${stamp}@example.test`],
    );
    accountId = r.rows[0].id;
    const seeded = await seedDraft({ accountId });
    draftId = seeded.draftId;
    inboxMessageId = seeded.inboxMessageId;
  });

  afterAll(async () => {
    const pool = getTestPool();
    // FK order: sent_history (→ drafts, inbox) → drafts (→ inbox) → inbox → account.
    await pool.query('DELETE FROM mailbox.sent_history WHERE account_id = $1', [accountId]);
    await pool.query('DELETE FROM mailbox.drafts WHERE account_id = $1', [accountId]);
    await pool.query('DELETE FROM mailbox.inbox_messages WHERE account_id = $1', [accountId]);
    await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [accountId]);
    await closeTestPool();
  });

  it('surfaces a stale no-reply send; excludes young + already-replied threads', async () => {
    await insertSend(`a-stale-${stamp}`, 30); // 30h > 24h threshold, no reply → awaiting
    await insertSend(`a-young-${stamp}`, 10); // 10h < 24h → not yet
    await insertSend(`a-replied-${stamp}`, 30); // sent 30h ago …
    await insertInbound(`a-replied-${stamp}`, 5); // … but they replied 5h ago → cleared

    const items = await getAwaitingReply({ accountId, env: ENV, limit: 100 });
    const ids = items.map((i) => i.thread_id);

    expect(ids).toContain(`a-stale-${stamp}`);
    expect(ids).not.toContain(`a-young-${stamp}`);
    expect(ids).not.toContain(`a-replied-${stamp}`);

    const stale = items.find((i) => i.thread_id === `a-stale-${stamp}`);
    expect(stale).toBeDefined();
    expect(stale?.to_addr).toBe('buyer@acme.com');
    expect(stale?.category).toBe('inquiry');
    expect(stale?.draft_id).toBe(draftId);
    expect(stale?.account_id).toBe(accountId);
    expect(stale?.age_hours).toBeGreaterThanOrEqual(24);
  });

  it('judges a thread on its LATEST send', async () => {
    // Newer send is young → the thread is NOT awaiting (we just replied again).
    await insertSend(`b-multi-${stamp}`, 40);
    await insertSend(`b-multi-${stamp}`, 5);
    // Two old sends → latest is still old → awaiting.
    await insertSend(`b-twoold-${stamp}`, 40);
    await insertSend(`b-twoold-${stamp}`, 30);

    const ids = (await getAwaitingReply({ accountId, env: ENV, limit: 100 })).map(
      (i) => i.thread_id,
    );
    expect(ids).not.toContain(`b-multi-${stamp}`);
    expect(ids).toContain(`b-twoold-${stamp}`);
  });

  it('respects the per-category threshold env', async () => {
    await insertSend(`c-30-${stamp}`, 30);
    const at24 = (
      await getAwaitingReply({ accountId, env: { FOLLOWUP_AGE_HOURS_INQUIRY: '24' } })
    ).map((i) => i.thread_id);
    const at48 = (
      await getAwaitingReply({ accountId, env: { FOLLOWUP_AGE_HOURS_INQUIRY: '48' } })
    ).map((i) => i.thread_id);
    expect(at24).toContain(`c-30-${stamp}`); // 30h ≥ 24 → awaiting
    expect(at48).not.toContain(`c-30-${stamp}`); // 30h < 48 → not yet
  });

  it('scopes to the requested account', async () => {
    // A bogus account id returns nothing — proves the account filter applies.
    const items = await getAwaitingReply({ accountId: 999_999_999, env: ENV });
    expect(items).toHaveLength(0);
  });
});
