// Integration tests for POST /api/drafts/[id]/approve → transitionToApprovedAndSend
// → triggerSendWebhook.
//
// triggerSendWebhook (lib/n8n.ts:74) uses global `fetch` directly. For a draft
// seeded via seedDraft() (no explicit accountId), the draft's account_id is the
// DB-column DEFAULT, which resolves to the seeded default account. That account
// has provider='gmail' (the column DEFAULT; confirmed in test/fixtures/schema.sql).
// Therefore triggerSendWebhook will call:
//   process.env.N8N_WEBHOOK_URL   (POST { draft_id })
// We stub N8N_WEBHOOK_URL to 'http://n8n.test/webhook/mailbox-send' and mock
// global fetch so no real HTTP leaves the process.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeTestPool,
  deleteSeededDraft,
  getDraftStatus,
  getTestPool,
  HAS_DB,
  type SeededDraft,
  seedDraft,
} from '../helpers/db';

const dbDescribe = HAS_DB ? describe : describe.skip;

const TEST_WEBHOOK_URL = 'http://n8n.test/webhook/mailbox-send';

// n8n MailBOX-Send success body shape (JSON-parsed by triggerSendWebhook).
const N8N_SUCCESS_BODY = JSON.stringify({ status: 'ok' });

dbDescribe('POST /api/drafts/[id]/approve — real Postgres', () => {
  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(() => {
    vi.stubEnv('N8N_WEBHOOK_URL', TEST_WEBHOOK_URL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Case 1: Happy path ────────────────────────────────────────────────────

  it('approves a pending draft: flips status to approved, calls webhook once, returns 200', async () => {
    const seeded: SeededDraft = await seedDraft({ status: 'pending' });

    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) => new Response(N8N_SUCCESS_BODY, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('@/app/api/drafts/[id]/approve/route');
    const res = await POST(
      {
        url: 'http://test.local/api/drafts/approve',
        json: async () => ({}),
      } as unknown as import('next/server').NextRequest,
      { params: { id: String(seeded.draftId) } },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.draft_id).toBe(seeded.draftId);

    // Row must be approved after a successful send.
    expect(await getDraftStatus(seeded.draftId)).toBe('approved');

    // Exactly one fetch call, to the gmail webhook URL, carrying the draft_id.
    const sendCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/webhook/mailbox-send'),
    );
    expect(sendCalls).toHaveLength(1);
    const sentBody = JSON.parse(sendCalls[0][1]?.body as string);
    expect(sentBody.draft_id).toBe(seeded.draftId);

    await deleteSeededDraft(seeded);
  });

  // ── Case 2: Wrong-state 409 ───────────────────────────────────────────────

  it('returns 409 and does not call the webhook when draft is already approved', async () => {
    const seeded: SeededDraft = await seedDraft({ status: 'approved' });

    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) => new Response(N8N_SUCCESS_BODY, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('@/app/api/drafts/[id]/approve/route');
    const res = await POST(
      {
        url: 'http://test.local/api/drafts/approve',
        json: async () => ({}),
      } as unknown as import('next/server').NextRequest,
      { params: { id: String(seeded.draftId) } },
    );

    expect(res.status).toBe(409);

    // Webhook must NOT be called when the state guard rejects.
    const sendCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/webhook/mailbox-send'),
    );
    expect(sendCalls).toHaveLength(0);

    await deleteSeededDraft(seeded);
  });

  // ── Case 3: Webhook failure contract ────────────────────────────────────

  it('returns 502, leaves row at approved, and persists error_message on webhook 5xx', async () => {
    const seeded: SeededDraft = await seedDraft({ status: 'pending' });

    // triggerSendWebhook maps !res.ok → { success: false, error: `Webhook returned 502: ...` }
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) => new Response('upstream error', { status: 502 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('@/app/api/drafts/[id]/approve/route');
    const res = await POST(
      {
        url: 'http://test.local/api/drafts/approve',
        json: async () => ({}),
      } as unknown as import('next/server').NextRequest,
      { params: { id: String(seeded.draftId) } },
    );
    const body = await res.json();

    // Wire: 502 with success:false + draft_id + error
    expect(res.status).toBe(502);
    expect(body.success).toBe(false);
    expect(body.draft_id).toBe(seeded.draftId);
    expect(typeof body.error).toBe('string');

    // Row stays at 'approved' — no rollback (by design, per STAQPRO-202 / STAQPRO-271).
    expect(await getDraftStatus(seeded.draftId)).toBe('approved');

    // error_message must be persisted to the drafts row for operator forensics.
    const pool = getTestPool();
    const r = await pool.query<{ error_message: string | null }>(
      'SELECT error_message FROM mailbox.drafts WHERE id = $1',
      [seeded.draftId],
    );
    expect(r.rows[0]?.error_message).toBeTruthy();
    expect(r.rows[0]?.error_message).toContain('502');

    await deleteSeededDraft(seeded);
  });

  // ── Case 4: clearError on re-approval ────────────────────────────────────

  it('clears error_message when re-approving a pending draft that had a prior failure', async () => {
    // Seed a pending draft that already has a stale error_message from a prior send failure.
    const seeded: SeededDraft = await seedDraft({ status: 'pending' });
    const pool = getTestPool();
    await pool.query(
      "UPDATE mailbox.drafts SET error_message = 'prior send failure' WHERE id = $1",
      [seeded.draftId],
    );

    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) => new Response(N8N_SUCCESS_BODY, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('@/app/api/drafts/[id]/approve/route');
    const res = await POST(
      {
        url: 'http://test.local/api/drafts/approve',
        json: async () => ({}),
      } as unknown as import('next/server').NextRequest,
      { params: { id: String(seeded.draftId) } },
    );

    expect(res.status).toBe(200);

    // clearError:true in the approve route must null out the stale error_message.
    const r = await pool.query<{ error_message: string | null }>(
      'SELECT error_message FROM mailbox.drafts WHERE id = $1',
      [seeded.draftId],
    );
    expect(r.rows[0]?.error_message).toBeNull();

    await deleteSeededDraft(seeded);
  });
});
