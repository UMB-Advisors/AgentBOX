import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeTestPool,
  deleteSeededDraft,
  fakeRequest,
  getTestPool,
  HAS_DB,
  seedDraft,
} from '../helpers/db';

// STAQPRO-185: mailbox.state_transitions trigger captures every drafts.status
// change. Asserts both the dashboard-driven path (approve route → actor =
// 'operator', reason = 'approve') and the n8n/direct-SQL path (no GUC set →
// actor defaults to 'system').

const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('state_transitions trigger — real Postgres', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
        ),
    );
    process.env.N8N_WEBHOOK_URL = 'http://stub.test/webhook';
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeTestPool();
  });

  it('logs operator-driven approve transition with reason', async () => {
    const seeded = await seedDraft({ status: 'pending' });
    try {
      const { POST } = await import('@/app/api/drafts/[id]/approve/route');
      const res = await POST(fakeRequest(), { params: { id: String(seeded.draftId) } });
      expect(res.status).toBe(200);

      const pool = getTestPool();
      const rows = await pool.query<{
        from_status: string;
        to_status: string;
        actor: string;
        reason: string | null;
      }>(
        `SELECT from_status, to_status, actor, reason
         FROM mailbox.state_transitions
         WHERE draft_id = $1
         ORDER BY transitioned_at ASC`,
        [seeded.draftId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        from_status: 'pending',
        to_status: 'approved',
        actor: 'operator',
        reason: 'approve',
      });
    } finally {
      await deleteSeededDraft(seeded);
    }
  });

  it('logs n8n/system-driven status flip with default actor', async () => {
    // Simulate n8n MailBOX-Send flipping status to 'sent' via a direct
    // Postgres node (no GUC set). Trigger should fire with actor='system'.
    const seeded = await seedDraft({ status: 'approved' });
    try {
      const pool = getTestPool();
      await pool.query(`UPDATE mailbox.drafts SET status = 'sent', sent_at = NOW() WHERE id = $1`, [
        seeded.draftId,
      ]);

      const rows = await pool.query<{
        from_status: string;
        to_status: string;
        actor: string;
        reason: string | null;
      }>(
        `SELECT from_status, to_status, actor, reason
         FROM mailbox.state_transitions
         WHERE draft_id = $1
         ORDER BY transitioned_at ASC`,
        [seeded.draftId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        from_status: 'approved',
        to_status: 'sent',
        actor: 'system',
        reason: null,
      });
    } finally {
      await deleteSeededDraft(seeded);
    }
  });

  it('does NOT log when status update is a no-op (same value)', async () => {
    const seeded = await seedDraft({ status: 'pending' });
    try {
      const pool = getTestPool();
      // Touch status to its current value — IS DISTINCT FROM should reject.
      await pool.query(`UPDATE mailbox.drafts SET status = 'pending' WHERE id = $1`, [
        seeded.draftId,
      ]);

      const rows = await pool.query(`SELECT 1 FROM mailbox.state_transitions WHERE draft_id = $1`, [
        seeded.draftId,
      ]);
      expect(rows.rows).toHaveLength(0);
    } finally {
      await deleteSeededDraft(seeded);
    }
  });
});
