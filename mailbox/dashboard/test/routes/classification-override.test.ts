import { afterAll, describe, expect, it } from 'vitest';
import {
  closeTestPool,
  deleteSeededDraft,
  fakeRequest,
  getTestPool,
  HAS_DB,
  seedDraft,
} from '../helpers/db';

// MBOX-123 — PATCH /api/drafts/[id]/classification operator override.
// Real-DB tests: happy path (drafts + inbox_messages relabel + classification_log
// append), invalid category (400, no mutation), draft-not-found (404). The
// schema-invariant assertion that the override category is valid against the
// live CHECK constraint lives in test/schema-invariants.test.ts.
//
// Skip suite cleanly when no DB is available.
const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('PATCH /api/drafts/[id]/classification — real Postgres', () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it('relabels the draft, syncs inbox_messages, and appends a classification_log row', async () => {
    // Seed with classification 'reorder'; override to 'escalate'.
    const seed = await seedDraft({ status: 'pending', classification: 'reorder' });
    try {
      const { PATCH } = await import('@/app/api/drafts/[id]/classification/route');
      const res = await PATCH(
        fakeRequest({
          body: { category: 'escalate', reason: 'customer is upset, I should reply' },
        }),
        { params: { id: String(seed.draftId) } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; draft: { category: string } };
      expect(body.success).toBe(true);
      expect(body.draft.category).toBe('escalate');

      const pool = getTestPool();

      // 1. drafts.classification_category relabeled.
      const draftRow = await pool.query<{ classification_category: string }>(
        'SELECT classification_category FROM mailbox.drafts WHERE id = $1',
        [seed.draftId],
      );
      expect(draftRow.rows[0].classification_category).toBe('escalate');

      // 2. inbox_messages.classification denorm column updated (by the route's
      //    explicit write AND/OR the migration-021 trigger — value is the same).
      const inboxRow = await pool.query<{ classification: string }>(
        'SELECT classification FROM mailbox.inbox_messages WHERE id = $1',
        [seed.inboxMessageId],
      );
      expect(inboxRow.rows[0].classification).toBe('escalate');

      // 3. classification_log append with operator attribution. model_version
      //    = 'operator-override' is the audit signal that this row is an
      //    operator relabel, not a model classification. raw_output carries
      //    the operator reason.
      const log = await pool.query<{
        category: string;
        model_version: string;
        confidence: number;
        json_parse_ok: boolean;
        raw_output: string | null;
      }>(
        `SELECT category, model_version, confidence, json_parse_ok, raw_output
           FROM mailbox.classification_log
          WHERE inbox_message_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [seed.inboxMessageId],
      );
      expect(log.rows[0].category).toBe('escalate');
      expect(log.rows[0].model_version).toBe('operator-override');
      expect(log.rows[0].confidence).toBe(1);
      expect(log.rows[0].json_parse_ok).toBe(true);
      expect(log.rows[0].raw_output).toBe('customer is upset, I should reply');
    } finally {
      await deleteSeededDraft(seed);
    }
  });

  it('accepts an override with no reason (raw_output NULL)', async () => {
    const seed = await seedDraft({ status: 'pending', classification: 'inquiry' });
    try {
      const { PATCH } = await import('@/app/api/drafts/[id]/classification/route');
      const res = await PATCH(fakeRequest({ body: { category: 'follow_up' } }), {
        params: { id: String(seed.draftId) },
      });
      expect(res.status).toBe(200);

      const pool = getTestPool();
      const log = await pool.query<{ category: string; raw_output: string | null }>(
        `SELECT category, raw_output FROM mailbox.classification_log
          WHERE inbox_message_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [seed.inboxMessageId],
      );
      expect(log.rows[0].category).toBe('follow_up');
      expect(log.rows[0].raw_output).toBeNull();
    } finally {
      await deleteSeededDraft(seed);
    }
  });

  it('rejects an unknown category with 400 and does not mutate', async () => {
    const seed = await seedDraft({ status: 'pending', classification: 'reorder' });
    try {
      const { PATCH } = await import('@/app/api/drafts/[id]/classification/route');
      const res = await PATCH(fakeRequest({ body: { category: 'not_a_real_category' } }), {
        params: { id: String(seed.draftId) },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('validation_failed');

      // No relabel, no extra log row.
      const pool = getTestPool();
      const draftRow = await pool.query<{ classification_category: string }>(
        'SELECT classification_category FROM mailbox.drafts WHERE id = $1',
        [seed.draftId],
      );
      expect(draftRow.rows[0].classification_category).toBe('reorder');
      const logCount = await pool.query<{ n: string }>(
        'SELECT COUNT(*) AS n FROM mailbox.classification_log WHERE inbox_message_id = $1',
        [seed.inboxMessageId],
      );
      expect(Number(logCount.rows[0].n)).toBe(0);
    } finally {
      await deleteSeededDraft(seed);
    }
  });

  it('returns 400 for a non-numeric id', async () => {
    const { PATCH } = await import('@/app/api/drafts/[id]/classification/route');
    const res = await PATCH(fakeRequest({ body: { category: 'escalate' } }), {
      params: { id: 'abc' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation_failed');
  });

  it('returns 404 for a nonexistent draft', async () => {
    const { PATCH } = await import('@/app/api/drafts/[id]/classification/route');
    const res = await PATCH(fakeRequest({ body: { category: 'escalate' } }), {
      params: { id: '999999999' },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('draft_not_found');
  });
});
