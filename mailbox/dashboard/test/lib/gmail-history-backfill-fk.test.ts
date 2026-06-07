import { afterAll, describe, expect, it } from 'vitest';
import { getKysely } from '@/lib/db';
import {
  type ParsedMessage,
  upsertInbound,
  upsertReply,
} from '@/lib/onboarding/gmail-history-backfill';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// STAQPRO-193 follow-up to Eric's PR review of #24: assert that the FK
// wiring (upsertInbound returns id → upsertReply writes inbox_message_id)
// works end-to-end. Without this, STAQPRO-153 persona extraction's LEFT JOIN
// on inbox_message_id yields NULL inbound context for every backfill row.

const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('upsertInbound + upsertReply FK wiring — real Postgres', () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it('returns the inbox_messages row id and propagates it as sent_history.inbox_message_id', async () => {
    const tag = `fk-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inbound: ParsedMessage = {
      message_id: `${tag}-inbound`,
      thread_id: `${tag}-thread`,
      from_addr: 'eric@staqs.io',
      to_addr: 'dustin@heronlabsinc.com',
      subject: `Test inbound ${tag}`,
      body: 'Hi Dustin, quick question on the next batch.',
      sent_at: '2026-04-15T09:00:00Z',
      in_reply_to: null,
      references: null,
      rfc822_message_id: null,
    };
    const reply: ParsedMessage = {
      message_id: `${tag}-reply`,
      thread_id: `${tag}-thread`,
      from_addr: 'dustin@heronlabsinc.com',
      to_addr: 'eric@staqs.io',
      subject: `Re: Test inbound ${tag}`,
      body: 'Hey Eric — yep, that works for me.',
      sent_at: '2026-04-15T09:30:00Z',
      in_reply_to: `${tag}-inbound`,
      references: null,
      rfc822_message_id: null,
    };

    const db = getKysely();
    const pool = getTestPool();

    try {
      const inboundResult = await upsertInbound(db, inbound);
      expect(inboundResult.result).toBe('inserted');
      expect(typeof inboundResult.id).toBe('number');
      expect(inboundResult.id).toBeGreaterThan(0);

      const replyResult = await upsertReply(db, inbound, reply, inboundResult.id);
      expect(replyResult).toBe('inserted');

      // Verify the FK actually landed in sent_history
      const r = await pool.query<{ inbox_message_id: number }>(
        `SELECT inbox_message_id FROM mailbox.sent_history WHERE message_id = $1`,
        [reply.message_id],
      );
      expect(r.rows[0]?.inbox_message_id).toBe(inboundResult.id);

      // Re-running upsertInbound on the same message_id returns 'existing'
      // with the same id — the fallback SELECT path in upsertInbound.
      const inboundAgain = await upsertInbound(db, inbound);
      expect(inboundAgain.result).toBe('existing');
      expect(inboundAgain.id).toBe(inboundResult.id);
    } finally {
      await pool.query('DELETE FROM mailbox.sent_history WHERE message_id = $1', [
        reply.message_id,
      ]);
      await pool.query('DELETE FROM mailbox.inbox_messages WHERE message_id = $1', [
        inbound.message_id,
      ]);
    }
  });
});
