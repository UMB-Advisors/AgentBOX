import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GMAIL_GET_LIMIT_BOOTSTRAP, GMAIL_GET_LIMIT_STEADY } from '@/lib/queries-system-state';
import { closeTestPool, fakeRequest, getTestPool, HAS_DB } from '../helpers/db';

const dbDescribe = HAS_DB ? describe : describe.skip;

// STAQPRO-226 — Gmail bootstrap mode routes.

dbDescribe('Gmail bootstrap mode — real Postgres', () => {
  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(async () => {
    // Reset singleton row to a clean bootstrap-incomplete state for each
    // test. Migration 022 backfills complete=true on appliances with inbox
    // history, so the test DB (which seeds inbox rows for other suites) will
    // typically arrive here at complete=true.
    const pool = getTestPool();
    await pool.query(`
      UPDATE mailbox.system_state
         SET bootstrap_complete = false,
             bootstrap_started_at = NULL,
             bootstrap_messages_seen = 0
       WHERE id = 1
    `);
  });

  describe('GET /api/internal/gmail-bootstrap', () => {
    it('returns throttled limit while incomplete', async () => {
      const { GET } = await import('@/app/api/internal/gmail-bootstrap/route');
      const res = await GET();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.bootstrap_complete).toBe(false);
      expect(json.gmail_get_limit).toBe(GMAIL_GET_LIMIT_BOOTSTRAP);
      expect(json.messages_seen).toBe(0);
    });

    it('returns steady-state limit after complete=true', async () => {
      const pool = getTestPool();
      await pool.query(`
        UPDATE mailbox.system_state SET bootstrap_complete = true WHERE id = 1
      `);
      const { GET } = await import('@/app/api/internal/gmail-bootstrap/route');
      const res = await GET();
      const json = await res.json();
      expect(json.bootstrap_complete).toBe(true);
      expect(json.gmail_get_limit).toBe(GMAIL_GET_LIMIT_STEADY);
    });
  });

  describe('POST /api/internal/gmail-cycle-complete', () => {
    it('rejects non-numeric messages_returned with 400', async () => {
      const { POST } = await import('@/app/api/internal/gmail-cycle-complete/route');
      const res = await POST(fakeRequest({ body: { messages_returned: 'lots' } }));
      expect(res.status).toBe(400);
    });

    it('full-bucket cycle increments counter without flipping', async () => {
      const { POST } = await import('@/app/api/internal/gmail-cycle-complete/route');
      const res = await POST(
        fakeRequest({ body: { messages_returned: GMAIL_GET_LIMIT_BOOTSTRAP } }),
      );
      const json = await res.json();
      expect(json.bootstrap_complete).toBe(false);
      expect(json.flipped_this_cycle).toBe(false);
      expect(json.bootstrap_messages_seen).toBe(GMAIL_GET_LIMIT_BOOTSTRAP);
    });

    it('partial-bucket cycle flips bootstrap_complete=true', async () => {
      const { POST } = await import('@/app/api/internal/gmail-cycle-complete/route');
      const res = await POST(
        fakeRequest({ body: { messages_returned: GMAIL_GET_LIMIT_BOOTSTRAP - 1 } }),
      );
      const json = await res.json();
      expect(json.bootstrap_complete).toBe(true);
      expect(json.flipped_this_cycle).toBe(true);
      expect(json.bootstrap_messages_seen).toBe(GMAIL_GET_LIMIT_BOOTSTRAP - 1);
    });

    it('empty cycle (0 messages) flips bootstrap_complete=true', async () => {
      const { POST } = await import('@/app/api/internal/gmail-cycle-complete/route');
      const res = await POST(fakeRequest({ body: { messages_returned: 0 } }));
      const json = await res.json();
      expect(json.bootstrap_complete).toBe(true);
      expect(json.flipped_this_cycle).toBe(true);
    });

    it('post-complete cycles are no-ops (counter stays put)', async () => {
      const pool = getTestPool();
      await pool.query(`
        UPDATE mailbox.system_state
           SET bootstrap_complete = true, bootstrap_messages_seen = 42
         WHERE id = 1
      `);
      const { POST } = await import('@/app/api/internal/gmail-cycle-complete/route');
      const res = await POST(
        fakeRequest({ body: { messages_returned: GMAIL_GET_LIMIT_BOOTSTRAP } }),
      );
      const json = await res.json();
      expect(json.bootstrap_complete).toBe(true);
      expect(json.flipped_this_cycle).toBe(false);
      expect(json.bootstrap_messages_seen).toBe(42);
    });
  });
});
