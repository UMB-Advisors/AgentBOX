import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeTestPool,
  deleteSeededDraft,
  fakeRequest,
  getDraftRow,
  getLatestTransition,
  getTestPool,
  HAS_DB,
  seedDraft,
} from '../helpers/db';

// MBOX-369 — real-DB tests for the per-row Gmail action routes
// (/api/inbox-messages/[id]/{archive,delete,mark-read,snooze}). Exercises the
// local disposition writes, the draft-coupling decision (archive keeps, delete
// discards), the audit trail on delete, the snooze validation + local-only
// behavior, the soft-warn on a Gmail webhook failure, and the queue-exclusion
// query filters.
const dbDescribe = HAS_DB ? describe : describe.skip;

// Read the disposition columns migration 036 added.
async function getInboxRow(id: number): Promise<{
  archived_at: string | null;
  deleted_at: string | null;
  snooze_until: string | null;
  is_read: boolean;
  gmail_action_state: string | null;
} | null> {
  const r = await getTestPool().query(
    `SELECT archived_at, deleted_at, snooze_until, is_read, gmail_action_state
       FROM mailbox.inbox_messages WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

function okFetch() {
  return vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
}

dbDescribe('inbox-message action routes — real Postgres', () => {
  beforeAll(() => {
    // Stub the n8n msg-action webhook (happy path → 200 JSON).
    vi.stubGlobal('fetch', okFetch());
    process.env.N8N_MSG_ACTION_URL = 'http://stub.test/webhook/mailbox-msg-action';
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeTestPool();
  });

  describe('POST /api/inbox-messages/[id]/archive', () => {
    it('sets archived_at + gmail_action_state=ok and KEEPS the draft', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/inbox-messages/[id]/archive/route');
        const res = await POST(fakeRequest(), { params: { id: String(seed.inboxMessageId) } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.gmail_synced).toBe(true);

        const inbox = await getInboxRow(seed.inboxMessageId);
        expect(inbox?.archived_at).not.toBeNull();
        expect(inbox?.gmail_action_state).toBe('ok');
        // Archive keeps the draft (MBOX-369 decision).
        const draft = await getDraftRow(seed.draftId);
        expect(draft?.status).toBe('pending');
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 404 for a nonexistent message id', async () => {
      const { POST } = await import('@/app/api/inbox-messages/[id]/archive/route');
      const res = await POST(fakeRequest(), { params: { id: '999999999' } });
      expect(res.status).toBe(404);
    });

    it('returns 400 for a non-numeric id', async () => {
      const { POST } = await import('@/app/api/inbox-messages/[id]/archive/route');
      const res = await POST(fakeRequest(), { params: { id: 'abc' } });
      expect(res.status).toBe(400);
    });

    it('soft-warns (200, gmail_synced=false, state=failed) when the Gmail webhook fails', async () => {
      // Empty body = upstream Gmail failure shape; local disposition still applied.
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response('', { status: 200 }))),
      );
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/inbox-messages/[id]/archive/route');
        const res = await POST(fakeRequest(), { params: { id: String(seed.inboxMessageId) } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.gmail_synced).toBe(false);
        expect(body.warning).toMatch(/did not sync/i);

        const inbox = await getInboxRow(seed.inboxMessageId);
        expect(inbox?.archived_at).not.toBeNull(); // local applied regardless
        expect(inbox?.gmail_action_state).toBe('failed');
      } finally {
        await deleteSeededDraft(seed);
        vi.stubGlobal('fetch', okFetch());
      }
    });
  });

  describe('POST /api/inbox-messages/[id]/mark-read', () => {
    it('sets is_read + gmail_action_state=ok and keeps the row/draft', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/inbox-messages/[id]/mark-read/route');
        const res = await POST(fakeRequest(), { params: { id: String(seed.inboxMessageId) } });
        expect(res.status).toBe(200);

        const inbox = await getInboxRow(seed.inboxMessageId);
        expect(inbox?.is_read).toBe(true);
        expect(inbox?.gmail_action_state).toBe('ok');
        expect(inbox?.archived_at).toBeNull(); // NOT removed from the queue
        const draft = await getDraftRow(seed.draftId);
        expect(draft?.status).toBe('pending');
      } finally {
        await deleteSeededDraft(seed);
      }
    });
  });

  describe('POST /api/inbox-messages/[id]/delete', () => {
    it('sets deleted_at, DISCARDS the draft (rejected), audits message_deleted', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/inbox-messages/[id]/delete/route');
        const res = await POST(fakeRequest(), { params: { id: String(seed.inboxMessageId) } });
        expect(res.status).toBe(200);

        const inbox = await getInboxRow(seed.inboxMessageId);
        expect(inbox?.deleted_at).not.toBeNull();
        // Delete discards the draft (MBOX-369 decision).
        const draft = await getDraftRow(seed.draftId);
        expect(draft?.status).toBe('rejected');
        // Audit row via the migration-009 trigger + GUCs.
        const t = await getLatestTransition(seed.draftId);
        expect(t?.to_status).toBe('rejected');
        expect(t?.actor).toBe('operator');
        expect(t?.reason).toBe('message_deleted');
      } finally {
        await deleteSeededDraft(seed);
      }
    });
  });

  describe('POST /api/inbox-messages/[id]/snooze', () => {
    it('sets snooze_until, makes NO Gmail call, leaves gmail_action_state null', async () => {
      const fetchSpy = vi.mocked(global.fetch);
      const before = fetchSpy.mock.calls.length;
      const seed = await seedDraft({ status: 'pending' });
      const until = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
      try {
        const { POST } = await import('@/app/api/inbox-messages/[id]/snooze/route');
        const res = await POST(fakeRequest({ body: { until } }), {
          params: { id: String(seed.inboxMessageId) },
        });
        expect(res.status).toBe(200);
        const inbox = await getInboxRow(seed.inboxMessageId);
        expect(inbox?.snooze_until).not.toBeNull();
        expect(inbox?.gmail_action_state).toBeNull(); // local-only, no write-through
        // Snooze must not fire the webhook.
        expect(fetchSpy.mock.calls.length).toBe(before);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('rejects a past instant with 400', async () => {
      const seed = await seedDraft({ status: 'pending' });
      const past = new Date(Date.now() - 60 * 1000).toISOString();
      try {
        const { POST } = await import('@/app/api/inbox-messages/[id]/snooze/route');
        const res = await POST(fakeRequest({ body: { until: past } }), {
          params: { id: String(seed.inboxMessageId) },
        });
        expect(res.status).toBe(400);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('rejects a missing until with 400', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/inbox-messages/[id]/snooze/route');
        const res = await POST(fakeRequest({ body: {} }), {
          params: { id: String(seed.inboxMessageId) },
        });
        expect(res.status).toBe(400);
      } finally {
        await deleteSeededDraft(seed);
      }
    });
  });

  describe('queue exclusion filters (lib/queries)', () => {
    it('listDrafts excludes an archived row', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { listDrafts } = await import('@/lib/queries');
        const before = await listDrafts(['pending'], 200);
        expect(before.map((d) => d.id)).toContain(seed.draftId);

        await getTestPool().query(
          `UPDATE mailbox.inbox_messages SET archived_at = NOW() WHERE id = $1`,
          [seed.inboxMessageId],
        );
        const after = await listDrafts(['pending'], 200);
        expect(after.map((d) => d.id)).not.toContain(seed.draftId);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('listDrafts hides a future-snoozed row but shows it once snooze passes', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { listDrafts } = await import('@/lib/queries');
        await getTestPool().query(
          `UPDATE mailbox.inbox_messages SET snooze_until = NOW() + interval '1 hour' WHERE id = $1`,
          [seed.inboxMessageId],
        );
        const hidden = await listDrafts(['pending'], 200);
        expect(hidden.map((d) => d.id)).not.toContain(seed.draftId);

        await getTestPool().query(
          `UPDATE mailbox.inbox_messages SET snooze_until = NOW() - interval '1 minute' WHERE id = $1`,
          [seed.inboxMessageId],
        );
        const resurfaced = await listDrafts(['pending'], 200);
        expect(resurfaced.map((d) => d.id)).toContain(seed.draftId);
      } finally {
        await deleteSeededDraft(seed);
      }
    });
  });
});
