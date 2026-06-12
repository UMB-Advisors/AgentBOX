import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeTestPool,
  deleteSeededDraft,
  fakeRequest,
  getTestPool,
  HAS_DB,
  seedDraft,
} from '../helpers/db';

// MBOX-129 — real-DB tests for POST /api/drafts/[id]/action-items/push. The
// Google Tasks provider is mocked (vi.mock) so the orchestration contract is
// exercised without a live Google account:
//   - single push populates task_external_id/url/pushed_at on the array element
//   - re-push is idempotent (PATCHes the same task id — no second create)
//   - bulk push handles all unpushed items
//   - a provider failure leaves the item unpushed + surfaces in results
//   - the push writes a mailbox.state_transitions audit row (push_task)
//
// Skip cleanly when no DB is available.
const dbDescribe = HAS_DB ? describe : describe.skip;

// Provider mock — replaced per-test. Default: create a deterministic task id.
const pushSpy = vi.fn(async (_item: unknown, _draftId: number, existingTaskId: string | null) => ({
  task_external_id: existingTaskId ?? 'gtask-new-1',
  task_external_url: 'https://tasks.google.com/task/gtask-new-1',
}));

vi.mock('@/lib/tasks/google-tasks', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    pushToGoogleTasks: (item: unknown, draftId: number, existingTaskId: string | null) =>
      pushSpy(item, draftId, existingTaskId),
  };
});

const ITEM_A = {
  text: 'Send the Q3 deck.',
  type: 'commitment',
  due_at: '2026-06-01T17:00:00.000Z',
  source: 'outbound',
  confidence: 0.9,
};
const ITEM_B = {
  text: 'Confirm the venue.',
  type: 'request',
  due_at: null,
  source: 'inbound',
  confidence: 0.8,
};

async function setItems(draftId: number, items: unknown[]): Promise<void> {
  const pool = getTestPool();
  await pool.query('UPDATE mailbox.drafts SET action_items = $2::jsonb WHERE id = $1', [
    draftId,
    JSON.stringify(items),
  ]);
}

async function readItems(draftId: number): Promise<Array<Record<string, unknown>>> {
  const pool = getTestPool();
  const r = await pool.query<{ action_items: Array<Record<string, unknown>> }>(
    'SELECT action_items FROM mailbox.drafts WHERE id = $1',
    [draftId],
  );
  return r.rows[0]?.action_items ?? [];
}

async function countPushAudits(draftId: number): Promise<number> {
  const pool = getTestPool();
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM mailbox.state_transitions
       WHERE draft_id = $1 AND reason LIKE 'push_task%'`,
    [draftId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

dbDescribe('POST /api/drafts/[id]/action-items/push — real Postgres', () => {
  beforeEach(() => {
    process.env.TASK_PROVIDER = 'google_tasks';
    pushSpy.mockClear();
    pushSpy.mockImplementation(async (_item, _draftId, existingTaskId) => ({
      task_external_id: existingTaskId ?? 'gtask-new-1',
      task_external_url: 'https://tasks.google.com/task/gtask-new-1',
    }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await closeTestPool();
  });

  it('pushes a single item and populates the task fields', async () => {
    const seed = await seedDraft({ status: 'pending' });
    try {
      await setItems(seed.draftId, [ITEM_A, ITEM_B]);
      const { POST } = await import('@/app/api/drafts/[id]/action-items/push/route');
      const res = await POST(fakeRequest({ body: { index: 0 } }), {
        params: Promise.resolve({ id: String(seed.draftId) }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        action_items: Array<Record<string, unknown>>;
      };
      expect(body.success).toBe(true);
      expect(body.action_items[0].task_external_id).toBe('gtask-new-1');
      expect(body.action_items[0].task_pushed_at).toBeTruthy();
      // Item B untouched.
      expect(body.action_items[1].task_external_id ?? null).toBeNull();

      const stored = await readItems(seed.draftId);
      expect(stored[0].task_external_id).toBe('gtask-new-1');
      expect(await countPushAudits(seed.draftId)).toBeGreaterThanOrEqual(1);
    } finally {
      await deleteSeededDraft(seed);
    }
  });

  it('re-push is idempotent — PATCHes the existing task id, no duplicate create', async () => {
    const seed = await seedDraft({ status: 'pending' });
    try {
      await setItems(seed.draftId, [{ ...ITEM_A, task_external_id: 'gtask-existing-7' }]);
      const { POST } = await import('@/app/api/drafts/[id]/action-items/push/route');
      await POST(fakeRequest({ body: { index: 0 } }), {
        params: Promise.resolve({ id: String(seed.draftId) }),
      });
      // The provider was called WITH the existing id (PATCH path), not null.
      expect(pushSpy).toHaveBeenCalledWith(expect.anything(), seed.draftId, 'gtask-existing-7');
      const stored = await readItems(seed.draftId);
      expect(stored[0].task_external_id).toBe('gtask-existing-7');
    } finally {
      await deleteSeededDraft(seed);
    }
  });

  it('bulk push handles all unpushed items', async () => {
    const seed = await seedDraft({ status: 'pending' });
    try {
      pushSpy.mockImplementation(async (_item, _draftId, existingTaskId) => ({
        task_external_id: existingTaskId ?? `gtask-${Math.random().toString(36).slice(2, 8)}`,
        task_external_url: 'https://tasks.google.com/',
      }));
      await setItems(seed.draftId, [ITEM_A, ITEM_B]);
      const { POST } = await import('@/app/api/drafts/[id]/action-items/push/route');
      const res = await POST(fakeRequest({ body: { all: true } }), {
        params: Promise.resolve({ id: String(seed.draftId) }),
      });
      expect(res.status).toBe(200);
      const stored = await readItems(seed.draftId);
      expect(stored[0].task_external_id).toBeTruthy();
      expect(stored[1].task_external_id).toBeTruthy();
      expect(pushSpy).toHaveBeenCalledTimes(2);
    } finally {
      await deleteSeededDraft(seed);
    }
  });

  it('a provider failure leaves the item unpushed and reports it', async () => {
    const seed = await seedDraft({ status: 'pending' });
    try {
      pushSpy.mockRejectedValue(new Error('boom'));
      await setItems(seed.draftId, [ITEM_A]);
      const { POST } = await import('@/app/api/drafts/[id]/action-items/push/route');
      const res = await POST(fakeRequest({ body: { index: 0 } }), {
        params: Promise.resolve({ id: String(seed.draftId) }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        results: Array<{ ok: boolean; error?: string }>;
      };
      expect(body.success).toBe(false);
      expect(body.results[0].ok).toBe(false);
      const stored = await readItems(seed.draftId);
      expect(stored[0].task_external_id ?? null).toBeNull();
    } finally {
      await deleteSeededDraft(seed);
    }
  });

  it('returns 400 for an out-of-range index', async () => {
    const seed = await seedDraft({ status: 'pending' });
    try {
      await setItems(seed.draftId, [ITEM_A]);
      const { POST } = await import('@/app/api/drafts/[id]/action-items/push/route');
      const res = await POST(fakeRequest({ body: { index: 9 } }), {
        params: Promise.resolve({ id: String(seed.draftId) }),
      });
      expect(res.status).toBe(400);
    } finally {
      await deleteSeededDraft(seed);
    }
  });

  it('returns 400 when neither index nor all is provided', async () => {
    const { POST } = await import('@/app/api/drafts/[id]/action-items/push/route');
    const res = await POST(fakeRequest({ body: {} }), { params: Promise.resolve({ id: '1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a nonexistent draft', async () => {
    const { POST } = await import('@/app/api/drafts/[id]/action-items/push/route');
    const res = await POST(fakeRequest({ body: { index: 0 } }), {
      params: Promise.resolve({ id: '999999999' }),
    });
    expect(res.status).toBe(404);
  });
});
