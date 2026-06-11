import { afterAll, describe, expect, it } from 'vitest';
import {
  closeTestPool,
  deleteSeededDraft,
  fakeRequest,
  getTestPool,
  HAS_DB,
  seedDraft,
} from '../helpers/db';

// MBOX-131 — real-DB tests for POST /api/drafts/[id]/action-items. Covers
// validation (param + body via zod) and the happy path (full-array replace +
// readback from mailbox.drafts.action_items).
//
// Skip suite cleanly when no DB is available.
const dbDescribe = HAS_DB ? describe : describe.skip;

async function readActionItems(draftId: number): Promise<unknown[]> {
  const pool = getTestPool();
  const r = await pool.query<{ action_items: unknown[] }>(
    'SELECT action_items FROM mailbox.drafts WHERE id = $1',
    [draftId],
  );
  return r.rows[0]?.action_items ?? [];
}

const VALID_ITEM = {
  text: 'Ship the reorder by Friday.',
  type: 'deadline',
  due_at: '2026-05-29T17:00:00.000Z',
  source: 'outbound',
  confidence: 0.9,
};

dbDescribe('POST /api/drafts/[id]/action-items — real Postgres', () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it('persists a valid action_items array and returns it', async () => {
    const seed = await seedDraft({ status: 'pending' });
    try {
      const { POST } = await import('@/app/api/drafts/[id]/action-items/route');
      const res = await POST(fakeRequest({ body: { action_items: [VALID_ITEM] } }), {
        params: Promise.resolve({ id: String(seed.draftId) }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        draft: { id: number; action_items: (typeof VALID_ITEM)[]; updated_at: string };
      };
      expect(body.success).toBe(true);
      expect(body.draft.id).toBe(seed.draftId);
      expect(body.draft.action_items).toHaveLength(1);
      expect(body.draft.action_items[0]).toMatchObject({ type: 'deadline', source: 'outbound' });

      const stored = await readActionItems(seed.draftId);
      expect(stored).toHaveLength(1);
    } finally {
      await deleteSeededDraft(seed);
    }
  });

  it('replaces the full array (empty array clears items)', async () => {
    const seed = await seedDraft({ status: 'pending' });
    try {
      const { POST } = await import('@/app/api/drafts/[id]/action-items/route');
      // Seed one item, then clear.
      await POST(fakeRequest({ body: { action_items: [VALID_ITEM] } }), {
        params: Promise.resolve({ id: String(seed.draftId) }),
      });
      const res = await POST(fakeRequest({ body: { action_items: [] } }), {
        params: Promise.resolve({ id: String(seed.draftId) }),
      });
      expect(res.status).toBe(200);
      const stored = await readActionItems(seed.draftId);
      expect(stored).toEqual([]);
    } finally {
      await deleteSeededDraft(seed);
    }
  });

  it('returns 404 for a nonexistent draft', async () => {
    const { POST } = await import('@/app/api/drafts/[id]/action-items/route');
    const res = await POST(fakeRequest({ body: { action_items: [] } }), {
      params: Promise.resolve({ id: '999999999' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('draft_not_found');
  });

  it('returns 400 for a non-numeric id', async () => {
    const { POST } = await import('@/app/api/drafts/[id]/action-items/route');
    const res = await POST(fakeRequest({ body: { action_items: [] } }), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_failed');
  });

  it('rejects an out-of-enum type with 400 and does not mutate', async () => {
    const seed = await seedDraft({ status: 'pending' });
    try {
      const { POST } = await import('@/app/api/drafts/[id]/action-items/route');
      const res = await POST(
        fakeRequest({
          body: { action_items: [{ ...VALID_ITEM, type: 'todo' }] },
        }),
        { params: Promise.resolve({ id: String(seed.draftId) }) },
      );
      expect(res.status).toBe(400);
      const stored = await readActionItems(seed.draftId);
      expect(stored).toEqual([]); // default '[]' — untouched
    } finally {
      await deleteSeededDraft(seed);
    }
  });

  it('rejects confidence > 1 with 400', async () => {
    const seed = await seedDraft({ status: 'pending' });
    try {
      const { POST } = await import('@/app/api/drafts/[id]/action-items/route');
      const res = await POST(
        fakeRequest({ body: { action_items: [{ ...VALID_ITEM, confidence: 1.5 }] } }),
        { params: Promise.resolve({ id: String(seed.draftId) }) },
      );
      expect(res.status).toBe(400);
    } finally {
      await deleteSeededDraft(seed);
    }
  });

  it('rejects a non-ISO due_at with 400', async () => {
    const seed = await seedDraft({ status: 'pending' });
    try {
      const { POST } = await import('@/app/api/drafts/[id]/action-items/route');
      const res = await POST(
        fakeRequest({ body: { action_items: [{ ...VALID_ITEM, due_at: 'next-friday' }] } }),
        { params: Promise.resolve({ id: String(seed.draftId) }) },
      );
      expect(res.status).toBe(400);
    } finally {
      await deleteSeededDraft(seed);
    }
  });
});
