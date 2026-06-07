import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeTestPool,
  deleteSeededDraft,
  fakeRequest,
  getTestPool,
  HAS_DB,
  seedDraft,
} from '../helpers/db';

// STAQPRO-121 capture-side: assert that the edit route snapshots the LLM's
// original draft_body into original_draft_body on first edit (and doesn't
// re-snapshot on subsequent edits), AND that the migration 010 archive
// trigger reads from original_draft_body when the draft was edited (so
// sent_history.draft_original carries the real LLM-original delta vs
// draft_sent).

const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('edit-snapshot + archive coupling — real Postgres', () => {
  beforeAll(() => {
    // Stub fetch so approve doesn't actually fire the n8n webhook.
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

  it('first edit snapshots the LLM original; second edit preserves the FIRST snapshot', async () => {
    const seeded = await seedDraft({
      status: 'pending',
      draftBody: 'LLM v1: Hi! Confirming order. — Heron Labs',
    });
    try {
      const { POST } = await import('@/app/api/drafts/[id]/edit/route');

      const res1 = await POST(
        fakeRequest({
          body: { draft_body: 'Operator v1: Hey, confirming the order.', draft_subject: null },
        }),
        { params: { id: String(seeded.draftId) } },
      );
      expect(res1.status).toBe(200);

      const pool = getTestPool();
      const after1 = await pool.query<{ original_draft_body: string | null; draft_body: string }>(
        'SELECT original_draft_body, draft_body FROM mailbox.drafts WHERE id = $1',
        [seeded.draftId],
      );
      expect(after1.rows[0].original_draft_body).toBe('LLM v1: Hi! Confirming order. — Heron Labs');
      expect(after1.rows[0].draft_body).toBe('Operator v1: Hey, confirming the order.');

      const res2 = await POST(
        fakeRequest({
          body: { draft_body: 'Operator v2: Hey, confirming!', draft_subject: null },
        }),
        { params: { id: String(seeded.draftId) } },
      );
      expect(res2.status).toBe(200);

      const after2 = await pool.query<{ original_draft_body: string | null; draft_body: string }>(
        'SELECT original_draft_body, draft_body FROM mailbox.drafts WHERE id = $1',
        [seeded.draftId],
      );
      // FIRST snapshot is preserved; not overwritten by the second edit.
      expect(after2.rows[0].original_draft_body).toBe('LLM v1: Hi! Confirming order. — Heron Labs');
      expect(after2.rows[0].draft_body).toBe('Operator v2: Hey, confirming!');
    } finally {
      await deleteSeededDraft(seeded);
    }
  });

  it('sent_history.draft_original = original_draft_body when the draft was edited', async () => {
    const seeded = await seedDraft({
      status: 'pending',
      draftBody: 'LLM original body',
    });
    try {
      const pool = getTestPool();
      const { POST: editPOST } = await import('@/app/api/drafts/[id]/edit/route');
      await editPOST(
        fakeRequest({ body: { draft_body: 'operator-tuned body', draft_subject: null } }),
        { params: { id: String(seeded.draftId) } },
      );

      // Simulate the n8n send pipeline: status → sent. Triggers archive_draft_to_sent_history.
      await pool.query(`UPDATE mailbox.drafts SET status = 'sent', sent_at = NOW() WHERE id = $1`, [
        seeded.draftId,
      ]);

      const archived = await pool.query<{ draft_original: string; draft_sent: string }>(
        `SELECT draft_original, draft_sent FROM mailbox.sent_history WHERE draft_id = $1`,
        [seeded.draftId],
      );
      expect(archived.rows[0].draft_original).toBe('LLM original body');
      expect(archived.rows[0].draft_sent).toBe('operator-tuned body');
    } finally {
      const pool = getTestPool();
      await pool.query('DELETE FROM mailbox.sent_history WHERE draft_id = $1', [seeded.draftId]);
      await deleteSeededDraft(seeded);
    }
  });

  it('sent_history.draft_original = draft_body when the draft was NEVER edited (fallback)', async () => {
    const seeded = await seedDraft({
      status: 'pending',
      draftBody: 'unedited LLM body',
    });
    try {
      const pool = getTestPool();
      // No edit; straight to sent.
      await pool.query(`UPDATE mailbox.drafts SET status = 'sent', sent_at = NOW() WHERE id = $1`, [
        seeded.draftId,
      ]);

      const archived = await pool.query<{ draft_original: string; draft_sent: string }>(
        `SELECT draft_original, draft_sent FROM mailbox.sent_history WHERE draft_id = $1`,
        [seeded.draftId],
      );
      // COALESCE falls through to draft_body since original_draft_body is null.
      expect(archived.rows[0].draft_original).toBe('unedited LLM body');
      expect(archived.rows[0].draft_sent).toBe('unedited LLM body');
    } finally {
      const pool = getTestPool();
      await pool.query('DELETE FROM mailbox.sent_history WHERE draft_id = $1', [seeded.draftId]);
      await deleteSeededDraft(seeded);
    }
  });
});
