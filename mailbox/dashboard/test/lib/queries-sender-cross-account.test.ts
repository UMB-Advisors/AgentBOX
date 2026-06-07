import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSenderAcrossAccounts } from '@/lib/queries-sender';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// MBOX-367 (MBOX-162 V4) — cross-account intelligence query. DB-backed: skips
// without TEST_POSTGRES_URL. Builds a 2-account fixture with a UNIQUE sender so
// it never collides with the 'sender@example.com' rows other suites seed.

const dbDescribe = HAS_DB ? describe : describe.skip;

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const SENDER = `cross-${stamp}@counterparty.test`;

dbDescribe('getSenderAcrossAccounts — real Postgres', () => {
  let accountA: number; // the seeded default account
  let accountB: number; // a 2nd connected inbox
  const inboxIds: number[] = [];
  const draftIds: number[] = [];

  beforeAll(async () => {
    const pool = getTestPool();
    const def = await pool.query<{ id: number }>(
      'SELECT id FROM mailbox.accounts WHERE is_default LIMIT 1',
    );
    accountA = def.rows[0].id;

    const b = await pool.query<{ id: number }>(
      `INSERT INTO mailbox.accounts (email_address, display_label, is_default, provider)
       VALUES ($1, 'Founder', false, 'gmail') RETURNING id`,
      [`v4-acct-b-${stamp}@example.test`],
    );
    accountB = b.rows[0].id;

    // 2 inbound from SENDER under account A, 1 under account B.
    async function seedInbox(accountId: number, n: number): Promise<number> {
      const r = await pool.query<{ id: number }>(
        `INSERT INTO mailbox.inbox_messages
           (message_id, from_addr, to_addr, subject, body, received_at, account_id)
         VALUES ($1, $2, 'op@example.com', 'hi', 'b', NOW() - ($3::int * INTERVAL '1 day'), $4)
         RETURNING id`,
        [`v4-msg-${stamp}-${accountId}-${n}`, SENDER, n, accountId],
      );
      inboxIds.push(r.rows[0].id);
      return r.rows[0].id;
    }
    const a1 = await seedInbox(accountA, 1);
    await seedInbox(accountA, 2);
    await seedInbox(accountB, 1);

    // A 'sent' draft under account A, linked back via inbox_messages.draft_id
    // (the denorm getSenderAcrossAccounts joins through) — exercises drafts_sent.
    const d = await pool.query<{ id: number }>(
      `INSERT INTO mailbox.drafts
         (inbox_message_id, draft_body, draft_subject, model, status,
          from_addr, to_addr, subject, body_text, account_id)
       VALUES ($1, 'reply', 'Re: hi', 'qwen3:4b-ctx4k', 'sent',
               $2, 'op@example.com', 'Re: hi', 'b', $3)
       RETURNING id`,
      [a1, SENDER, accountA],
    );
    draftIds.push(d.rows[0].id);
    await pool.query('UPDATE mailbox.inbox_messages SET draft_id = $1 WHERE id = $2', [
      d.rows[0].id,
      a1,
    ]);
  });

  afterAll(async () => {
    const pool = getTestPool();
    // inbox_messages.draft_id → drafts is NO ACTION, so clear the denorm link
    // before deleting the drafts (otherwise the draft delete violates the FK).
    for (const id of inboxIds)
      await pool.query('UPDATE mailbox.inbox_messages SET draft_id = NULL WHERE id = $1', [id]);
    for (const id of draftIds) await pool.query('DELETE FROM mailbox.drafts WHERE id = $1', [id]);
    for (const id of inboxIds)
      await pool.query('DELETE FROM mailbox.inbox_messages WHERE id = $1', [id]);
    await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [accountB]);
    await closeTestPool();
  });

  it('from account B, surfaces account A (excludes B itself)', async () => {
    const rows = await getSenderAcrossAccounts(SENDER, accountB);
    const a = rows.find((r) => r.account_id === accountA);
    expect(a).toBeDefined();
    expect(a?.total_emails).toBe(2);
    expect(a?.drafts_sent).toBe(1);
    expect(a?.last_seen_at).not.toBeNull();
    // The current account is never in its own cross-account list.
    expect(rows.some((r) => r.account_id === accountB)).toBe(false);
  });

  it('from account A, surfaces account B (excludes A itself)', async () => {
    const rows = await getSenderAcrossAccounts(SENDER, accountA);
    const b = rows.find((r) => r.account_id === accountB);
    expect(b).toBeDefined();
    expect(b?.total_emails).toBe(1);
    expect(b?.account_label).toBe('Founder');
    expect(rows.some((r) => r.account_id === accountA)).toBe(false);
  });

  it('returns [] for an unknown sender and for blank input', async () => {
    expect(await getSenderAcrossAccounts(`nobody-${stamp}@nowhere.test`, accountA)).toEqual([]);
    expect(await getSenderAcrossAccounts('', accountA)).toEqual([]);
  });
});

describe('getSenderAcrossAccounts — guard', () => {
  it(HAS_DB ? 'runs against Postgres' : 'skips without TEST_POSTGRES_URL', () => {
    expect(typeof getSenderAcrossAccounts).toBe('function');
  });
});
