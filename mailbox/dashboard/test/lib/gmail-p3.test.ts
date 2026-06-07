import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getKysely } from '@/lib/db';
import { type GmailMessage, gmailMessageToCanonical } from '@/lib/mail/gmail-parse';
import { runGmailVoiceBackfill } from '@/lib/mail/gmail-voice-backfill';
import type { CanonicalMessage, MailProvider } from '@/lib/mail/providers/types';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// MBOX-399 (MBOX-162 V6 P3) — two cores:
//  1) the PURE Gmail message → CanonicalMessage mapping (no DB / network), and
//  2) the runGmailVoiceBackfill orchestrator over a real Postgres with a FAKE
//     provider + injected token (the live Gmail REST path itself is M1-only).
//
// NOTE: the account_id-in-state round-trip that the P2-era draft of this suite
// asserted is GONE — master's signState/verifyState already thread a REQUIRED
// account_id (MBOX-415) and are covered by the oauth suite; re-testing the old
// optional-account_id signature here would assert a contract that no longer
// exists.

const NOW = new Date('2026-05-30T12:00:00.000Z');
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function msg(overrides: Partial<GmailMessage>): GmailMessage {
  return overrides;
}

describe('gmailMessageToCanonical', () => {
  it('maps headers + a text/plain part to an outbound CanonicalMessage', () => {
    const m = gmailMessageToCanonical(
      msg({
        id: 'gmailid123',
        internalDate: '1748600000000',
        payload: {
          mimeType: 'multipart/alternative',
          headers: [
            { name: 'From', value: 'founder@startup.test' },
            { name: 'To', value: 'customer@example.com' },
            { name: 'Subject', value: 'Re: your order' },
            { name: 'Message-ID', value: '<abc@startup.test>' },
            { name: 'Date', value: 'Fri, 01 May 2026 09:00:00 +0000' },
            { name: 'References', value: '<root@x> <prev@x>' },
          ],
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('Hi — happy to help. Best, Dustin') } },
            { mimeType: 'text/html', body: { data: b64url('<p>ignored</p>') } },
          ],
        },
      }),
      NOW,
    );
    expect(m).toEqual({
      provider_message_id: 'abc@startup.test',
      thread_id: null,
      from_addr: 'founder@startup.test',
      to_addr: 'customer@example.com',
      subject: 'Re: your order',
      body: 'Hi — happy to help. Best, Dustin',
      in_reply_to: null,
      references: '<root@x> <prev@x>',
      received_at: '2026-05-01T09:00:00.000Z',
      direction: 'outbound',
    });
  });

  it('falls back to tag-stripped HTML when there is no text/plain part', () => {
    const m = gmailMessageToCanonical(
      msg({
        payload: {
          mimeType: 'text/html',
          headers: [{ name: 'Message-ID', value: 'x@y' }],
          body: { data: b64url('<p>Hello&nbsp;<b>world</b></p>') },
        },
      }),
      NOW,
    );
    expect(m.body).toBe('Hello world');
    expect(m.provider_message_id).toBe('x@y');
  });

  it('uses internalDate then now when the Date header is missing/invalid', () => {
    const m = gmailMessageToCanonical(
      msg({
        internalDate: '1748600000000',
        payload: { headers: [{ name: 'Message-ID', value: 'a@b' }], body: { data: b64url('hi') } },
      }),
      NOW,
    );
    expect(m.received_at).toBe(new Date(1748600000000).toISOString());
  });

  it('falls back to the Gmail id when there is no RFC822 Message-ID header', () => {
    const m = gmailMessageToCanonical(
      msg({ id: 'gmail-native-id', payload: { body: { data: b64url('body only') } } }),
      NOW,
    );
    expect(m.provider_message_id).toBe('gmail-native-id');
    expect(m.body).toBe('body only');
  });
});

// ── runGmailVoiceBackfill — real Postgres, fake provider + injected token ─────

const dbDescribe = HAS_DB ? describe : describe.skip;
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function fixtureMessages(): CanonicalMessage[] {
  return [
    {
      provider_message_id: `gvb-${stamp}-a@mail.example.com`,
      thread_id: null,
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
      provider_message_id: `gvb-${stamp}-b@mail.example.com`,
      thread_id: null,
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
    kind: 'gmail',
    capabilities: { nativeThreading: true, push: false, quoteStrategy: 'gmail' },
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

// The injected token resolver stands in for the per-account gmail.readonly
// grant — the fake provider ignores the value, so no network is touched.
const fakeToken = async () => 'fake-access-token';

dbDescribe('runGmailVoiceBackfill — real Postgres, fake provider', () => {
  let accountId: number;
  const messageIds = fixtureMessages().map((m) => m.provider_message_id);

  beforeAll(async () => {
    const pool = getTestPool();
    const r = await pool.query<{ id: number }>(
      `INSERT INTO mailbox.accounts
         (email_address, display_label, is_default, provider, provider_config)
       VALUES ($1, 'GVB Test', false, 'gmail', '{}'::jsonb)
       RETURNING id`,
      [`gvb-${stamp}@example.test`],
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
    const counts = await runGmailVoiceBackfill(
      accountId,
      {},
      { db: getKysely(), provider: fakeProvider(fixtureMessages()), getAccessToken: fakeToken },
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
    await runGmailVoiceBackfill(
      accountId,
      {},
      { db: getKysely(), provider: fakeProvider(fixtureMessages()), getAccessToken: fakeToken },
    );
    const second = await runGmailVoiceBackfill(
      accountId,
      {},
      { db: getKysely(), provider: fakeProvider(fixtureMessages()), getAccessToken: fakeToken },
    );
    expect(second.messages_seen).toBe(2);
    expect(second.sent_history_upserts).toBe(0);
    expect(second.skipped_existing).toBe(2);

    const pool = getTestPool();
    const count = await pool.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM mailbox.sent_history WHERE account_id = $1 AND message_id = ANY($2)',
      [accountId, messageIds],
    );
    expect(count.rows[0].n).toBe('2');
  });

  it('rejects a non-gmail account with VoiceBackfillError (no token call)', async () => {
    const pool = getTestPool();
    const imapRow = await pool.query<{ id: number }>(
      `INSERT INTO mailbox.accounts (email_address, is_default, provider, provider_config)
       VALUES ($1, false, 'imap', '{}'::jsonb) RETURNING id`,
      [`gvb-imap-${stamp}@example.test`],
    );
    const imapId = imapRow.rows[0].id;
    try {
      await expect(
        runGmailVoiceBackfill(imapId, {}, { db: getKysely(), getAccessToken: fakeToken }),
      ).rejects.toThrow(/gmail-only/);
    } finally {
      await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [imapId]);
    }
  });
});
