import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getKysely } from '@/lib/db';
import { runImapVoiceBackfill } from '@/lib/mail/imap-voice-backfill';
import type { CanonicalMessage, MailProvider } from '@/lib/mail/providers/types';
import { encryptToken } from '@/lib/oauth/google';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// The orchestrator calls decryptToken(provider_secret_enc) before streaming, so
// the test account needs a real encrypted credential. The encrypt/decrypt
// helpers read MAILBOX_OAUTH_TOKEN_KEY at call-time (not import-time), so
// setting it here (and again in beforeAll) is sufficient. We inject a fake
// provider, so the decrypted password is never actually used over the network.
process.env.MAILBOX_OAUTH_TOKEN_KEY ??= '0'.repeat(64);

// MBOX-373 (MBOX-162 V6 P2) — orchestrator DB test. Injects a FAKE provider
// (no network) + the real test kysely, asserts sent_history rows land with
// source='backfill' / inbox_message_id NULL / the right account_id, and that a
// second run dedups on (account_id, message_id). DB-backed: skips cleanly
// without TEST_POSTGRES_URL (same gate as every other DB suite here).

const dbDescribe = HAS_DB ? describe : describe.skip;

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function fixtureMessages(): CanonicalMessage[] {
  return [
    {
      provider_message_id: `vb-${stamp}-a@mail.example.com`,
      thread_id: `imap-${stamp}aaa`,
      from_addr: 'operator@example.com',
      to_addr: 'customer@buyer.com',
      subject: 'Re: order A',
      body: 'Thanks — shipping today.',
      in_reply_to: null,
      references: null,
      received_at: '2026-05-20T10:00:00.000Z',
      direction: 'outbound',
    },
    {
      provider_message_id: `vb-${stamp}-b@mail.example.com`,
      thread_id: `imap-${stamp}bbb`,
      from_addr: 'operator@example.com',
      to_addr: 'vendor@supplier.com',
      subject: 'Re: invoice B',
      body: 'Payment scheduled for Friday.',
      in_reply_to: null,
      references: null,
      received_at: '2026-05-21T11:00:00.000Z',
      direction: 'outbound',
    },
  ];
}

function fakeProvider(msgs: CanonicalMessage[]): MailProvider {
  return {
    kind: 'imap',
    capabilities: { nativeThreading: false, push: false, quoteStrategy: 'generic' },
    normalize: () => {
      throw new Error('not used');
    },
    normalizeThreadId: () => null,
    parseRateLimit: () => ({ until: null }),
    listNew: () => {
      throw new Error('not used');
    },
    send: () => {
      throw new Error('not used');
    },
    backfillSent: async function* () {
      for (const m of msgs) yield m;
    },
  };
}

dbDescribe('runImapVoiceBackfill — real Postgres, fake provider', () => {
  let accountId: number;
  const messageIds = fixtureMessages().map((m) => m.provider_message_id);

  beforeAll(async () => {
    process.env.MAILBOX_OAUTH_TOKEN_KEY ??= '0'.repeat(64);
    const pool = getTestPool();
    const r = await pool.query<{ id: number }>(
      `INSERT INTO mailbox.accounts
         (email_address, display_label, is_default, provider, provider_config, provider_secret_enc)
       VALUES ($1, 'VB Test', false, 'imap', $2::jsonb, $3)
       RETURNING id`,
      [
        `vb-${stamp}@example.test`,
        JSON.stringify({
          imap_host: 'imap.example.test',
          imap_port: 993,
          username: `vb-${stamp}@example.test`,
          tls: true,
        }),
        encryptToken('dummy-app-password'),
      ],
    );
    accountId = r.rows[0].id;
  });

  afterEach(async () => {
    const pool = getTestPool();
    await pool.query('DELETE FROM mailbox.sent_history WHERE account_id = $1', [accountId]);
  });

  afterAll(async () => {
    const pool = getTestPool();
    await pool.query('DELETE FROM mailbox.sent_history WHERE account_id = $1', [accountId]);
    await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [accountId]);
    await closeTestPool();
  });

  it('upserts Sent-only rows: source=backfill, inbox_message_id NULL, correct account_id', async () => {
    const msgs = fixtureMessages();
    const counts = await runImapVoiceBackfill(
      accountId,
      {},
      { db: getKysely(), provider: fakeProvider(msgs) },
    );
    expect(counts.messages_seen).toBe(2);
    expect(counts.sent_history_upserts).toBe(2);
    expect(counts.skipped_existing).toBe(0);
    expect(counts.malformed).toBe(0);

    const pool = getTestPool();
    const rows = await pool.query<{
      source: string;
      inbox_message_id: number | null;
      draft_id: number | null;
      account_id: number;
      draft_sent: string;
      classification_category: string;
    }>(
      `SELECT source, inbox_message_id, draft_id, account_id, draft_sent, classification_category
         FROM mailbox.sent_history
        WHERE account_id = $1
        ORDER BY sent_at ASC`,
      [accountId],
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.source).toBe('backfill');
      expect(row.inbox_message_id).toBeNull();
      expect(row.draft_id).toBeNull();
      expect(row.account_id).toBe(accountId);
      expect(row.classification_category).toBe('unknown');
    }
    expect(rows.rows[0].draft_sent).toContain('shipping today');
  });

  it('dedups on a second run (account_id, message_id) → skipped_existing', async () => {
    const msgs = fixtureMessages();
    await runImapVoiceBackfill(accountId, {}, { db: getKysely(), provider: fakeProvider(msgs) });
    const second = await runImapVoiceBackfill(
      accountId,
      {},
      { db: getKysely(), provider: fakeProvider(msgs) },
    );
    expect(second.messages_seen).toBe(2);
    expect(second.sent_history_upserts).toBe(0);
    expect(second.skipped_existing).toBe(2);

    const pool = getTestPool();
    const count = await pool.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM mailbox.sent_history WHERE account_id = $1 AND message_id = ANY($2)',
      [accountId, messageIds],
    );
    expect(count.rows[0].n).toBe('2'); // not 4 — the second run inserted nothing
  });
});
