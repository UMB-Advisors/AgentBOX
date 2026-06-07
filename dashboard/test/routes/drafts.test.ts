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

// Real-DB tests for the drafts CRUD routes. State-machine transitions are the
// most failure-prone surface — these tests exercise the SQL guards (the
// `AND status IN (...)` clauses that produce 409 on wrong-state) plus the
// happy paths.
//
// Skip suite cleanly when no DB is available.
const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('drafts route handlers — real Postgres', () => {
  beforeAll(() => {
    // Stub fetch so approve/retry don't actually hit the n8n webhook.
    // Use mockImplementation so each call gets a *fresh* Response — Response
    // bodies are single-use, so a shared mockResolvedValue would 502 on the
    // second webhook caller.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
        ),
    );
    // Webhook URL must be set or triggerSendWebhook short-circuits to 502.
    process.env.N8N_WEBHOOK_URL = 'http://stub.test/webhook';
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeTestPool();
  });

  describe('GET /api/drafts/[id]', () => {
    it('returns 404 for nonexistent draft', async () => {
      const { GET } = await import('@/app/api/drafts/[id]/route');
      const res = await GET(fakeRequest(), {
        params: { id: '999999999' },
      });
      expect(res.status).toBe(404);
    });

    it('returns 400 for non-numeric id', async () => {
      const { GET } = await import('@/app/api/drafts/[id]/route');
      const res = await GET(fakeRequest(), { params: { id: 'abc' } });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('validation_failed');
    });
  });

  describe('POST /api/drafts/[id]/approve', () => {
    it('flips pending → approved and fires webhook', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/approve/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(200);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('approved');
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 409 when draft is already sent', async () => {
      const seed = await seedDraft({ status: 'sent' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/approve/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(409);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('sent'); // unchanged
      } finally {
        await deleteSeededDraft(seed);
      }
    });
  });

  describe('POST /api/drafts/[id]/reject', () => {
    // STAQPRO-331 #1 — reject route now writes mailbox.draft_feedback with
    // structured reason_code + optional free_text. error_message is NO LONGER
    // written here (it's send-side per CLAUDE.md state machine).
    it('flips pending → rejected and inserts draft_feedback row', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/reject/route');
        const res = await POST(
          fakeRequest({
            body: { reason_code: 'wrong_tone', free_text: '  too formal  ' },
          }),
          { params: { id: String(seed.draftId) } },
        );
        expect(res.status).toBe(200);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('rejected');
        // error_message is reserved for send-side failures now (Gmail Reply
        // 429 etc) — reject must not touch it.
        expect(row?.error_message).toBeNull();

        // Feedback row written in the same transaction.
        const { getKysely } = await import('@/lib/db');
        const fb = await getKysely()
          .selectFrom('draft_feedback')
          .selectAll()
          .where('draft_id', '=', seed.draftId)
          .execute();
        expect(fb).toHaveLength(1);
        expect(fb[0].reason_code).toBe('wrong_tone');
        expect(fb[0].free_text).toBe('too formal');
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it("requires free_text when reason_code is 'other'", async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/reject/route');
        const res = await POST(fakeRequest({ body: { reason_code: 'other' } }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(400);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('pending');
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('rejects body without reason_code with 400', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/reject/route');
        const res = await POST(fakeRequest({ body: {} }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(400);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 409 for already-approved drafts', async () => {
      const seed = await seedDraft({ status: 'approved' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/reject/route');
        const res = await POST(fakeRequest({ body: { reason_code: 'wrong_tone' } }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(409);
      } finally {
        await deleteSeededDraft(seed);
      }
    });
  });

  describe('POST /api/drafts/[id]/edit', () => {
    it('updates body, transitions to edited', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/edit/route');
        const res = await POST(
          fakeRequest({
            body: {
              draft_body: 'Hand-edited body for the test',
              draft_subject: 'Re: edited',
            },
          }),
          { params: { id: String(seed.draftId) } },
        );
        expect(res.status).toBe(200);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('edited');
        expect(row?.draft_body).toBe('Hand-edited body for the test');
        expect(row?.draft_subject).toBe('Re: edited');
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('rejects empty draft_body with 400', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/edit/route');
        const res = await POST(fakeRequest({ body: { draft_body: '   ' } }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(400);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 409 when draft is in a terminal state (rejected)', async () => {
      // STAQPRO-202 / migration 016 retired the 'failed' status; 'rejected'
      // is the canonical terminal state the edit guard must refuse.
      const seed = await seedDraft({ status: 'rejected' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/edit/route');
        const res = await POST(fakeRequest({ body: { draft_body: 'any body' } }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(409);
      } finally {
        await deleteSeededDraft(seed);
      }
    });
  });

  describe('POST /api/drafts/[id]/retry', () => {
    it('re-fires webhook for stuck-at-approved draft and clears error', async () => {
      // STAQPRO-202 / migration 016 — retry now only advances rows stuck at
      // status='approved' (Gmail Reply errors leave them there; the
      // StuckApproved UI surfaces them for operator-driven re-send).
      const seed = await seedDraft({ status: 'approved' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/retry/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(200);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('approved');
        expect(row?.error_message).toBeNull();
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 409 when draft is pending (retry only valid from approved)', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/retry/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(409);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 429 gmail_rate_limit_active when system cooldown is set (STAQPRO-227 stretch)', async () => {
      const seed = await seedDraft({ status: 'approved' });
      const pool = getTestPool();
      // Set system cooldown 10 min in the future. Restored after.
      await pool.query(
        `INSERT INTO mailbox.mail_cooldowns (account_id, provider, until, set_at)
         SELECT id, 'gmail', NOW() + interval '10 minutes', NOW() FROM mailbox.accounts WHERE is_default
         ON CONFLICT (account_id, provider) DO UPDATE SET until = EXCLUDED.until, set_at = NOW()`,
      );
      try {
        const { POST } = await import('@/app/api/drafts/[id]/retry/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(429);
        const body = (await res.json()) as { error: string; next_retry_at: string };
        expect(body.error).toBe('gmail_rate_limit_active');
        expect(typeof body.next_retry_at).toBe('string');
        expect(new Date(body.next_retry_at).getTime()).toBeGreaterThan(Date.now());
        // System cooldown gates ALL retries, regardless of per-draft last_retry_at
        // — confirm no n8n call was made (last_retry_at unchanged from seed=NULL)
        const r = await pool.query<{ last_retry_at: string | null }>(
          `SELECT last_retry_at FROM mailbox.drafts WHERE id = $1`,
          [seed.draftId],
        );
        expect(r.rows[0]?.last_retry_at).toBeNull();
      } finally {
        // Clear system cooldown so other tests aren't gated.
        await pool.query(
          `DELETE FROM mailbox.mail_cooldowns WHERE provider = 'gmail' AND account_id = (SELECT id FROM mailbox.accounts WHERE is_default)`,
        );
        await deleteSeededDraft(seed);
      }
    });

    it('returns 429 with next_retry_at when within 5-minute cooldown (STAQPRO-227)', async () => {
      const seed = await seedDraft({ status: 'approved' });
      try {
        // Stamp a recent retry to trigger the cooldown.
        const pool = getTestPool();
        await pool.query(
          `UPDATE mailbox.drafts SET last_retry_at = NOW() - interval '1 minute' WHERE id = $1`,
          [seed.draftId],
        );
        const { POST } = await import('@/app/api/drafts/[id]/retry/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(429);
        const body = (await res.json()) as { error: string; next_retry_at: string };
        expect(body.error).toBe('retry_cooldown');
        expect(typeof body.next_retry_at).toBe('string');
        // next_retry_at should be in the future
        expect(new Date(body.next_retry_at).getTime()).toBeGreaterThan(Date.now());
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('stamps last_retry_at on successful retry (STAQPRO-227)', async () => {
      const seed = await seedDraft({ status: 'approved' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/retry/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(200);
        const pool = getTestPool();
        const r = await pool.query<{ last_retry_at: string | null }>(
          `SELECT last_retry_at FROM mailbox.drafts WHERE id = $1`,
          [seed.draftId],
        );
        expect(r.rows[0]?.last_retry_at).not.toBeNull();
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('persists error_message on webhook failure (STAQPRO-271 AC #4)', async () => {
      // Simulate n8n returning an empty body (the 2026-05-08 Gmail-Reply
      // rate-limit failure shape). The webhook tolerates the empty body
      // (lib/n8n.ts) and surfaces a structured error; the transition helper
      // must persist that error to drafts.error_message so the operator can
      // see why send failed without grepping execution_data.
      const failFetch = vi.fn(() => Promise.resolve(new Response('', { status: 200 })));
      vi.stubGlobal('fetch', failFetch);

      const seed = await seedDraft({ status: 'approved' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/retry/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(502);
        const body = (await res.json()) as { success: boolean; error: string };
        expect(body.success).toBe(false);
        expect(body.error).toMatch(/empty body/i);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('approved'); // unchanged — no rollback policy
        expect(row?.error_message).toBeTruthy();
        expect(row?.error_message).toMatch(/empty body/i);
      } finally {
        await deleteSeededDraft(seed);
        // Restore the suite-level happy-path fetch stub.
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockImplementation(() =>
              Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
            ),
        );
      }
    });
  });

  describe('GET /api/drafts (list)', () => {
    it('filters by status', async () => {
      const seedA = await seedDraft({ status: 'pending' });
      const seedB = await seedDraft({ status: 'rejected' });
      try {
        const { GET } = await import('@/app/api/drafts/route');
        const res = await GET(
          fakeRequest({ url: 'http://test/api/drafts?status=rejected&limit=250' }),
        );
        expect(res.status).toBe(200);
        const json = (await res.json()) as { drafts: Array<{ id: number }> };
        const ids = json.drafts.map((d) => d.id);
        expect(ids).toContain(seedB.draftId);
        expect(ids).not.toContain(seedA.draftId);
      } finally {
        await deleteSeededDraft(seedA);
        await deleteSeededDraft(seedB);
      }
    });

    it('rejects unknown status with 400', async () => {
      const { GET } = await import('@/app/api/drafts/route');
      const res = await GET(fakeRequest({ url: 'http://test/api/drafts?status=bogus' }));
      expect(res.status).toBe(400);
    });

    // MBOX-360 (MBOX-162 V3) — the account filter narrows the unified queue to
    // one connected inbox; omitting it returns every account's drafts.
    it('filters by account', async () => {
      const pool = getTestPool();
      const acct = await pool.query<{ id: number }>(
        `INSERT INTO mailbox.accounts (email_address, display_label, is_default)
         VALUES ($1, 'V3 Filter Test', false) RETURNING id`,
        [`v3-filter-${Date.now()}@example.com`],
      );
      const otherAccountId = acct.rows[0].id;
      const seedDefault = await seedDraft({ status: 'pending' });
      const seedOther = await seedDraft({ status: 'pending', accountId: otherAccountId });
      try {
        const { GET } = await import('@/app/api/drafts/route');

        // Scoped to the 2nd account → only its draft.
        const scoped = await GET(
          fakeRequest({
            url: `http://test/api/drafts?status=pending&limit=250&account=${otherAccountId}`,
          }),
        );
        expect(scoped.status).toBe(200);
        const scopedIds = ((await scoped.json()) as { drafts: Array<{ id: number }> }).drafts.map(
          (d) => d.id,
        );
        expect(scopedIds).toContain(seedOther.draftId);
        expect(scopedIds).not.toContain(seedDefault.draftId);

        // No filter → both accounts' drafts.
        const all = await GET(
          fakeRequest({ url: 'http://test/api/drafts?status=pending&limit=250' }),
        );
        const allIds = ((await all.json()) as { drafts: Array<{ id: number }> }).drafts.map(
          (d) => d.id,
        );
        expect(allIds).toContain(seedOther.draftId);
        expect(allIds).toContain(seedDefault.draftId);
      } finally {
        await deleteSeededDraft(seedDefault);
        await deleteSeededDraft(seedOther);
        await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [otherAccountId]);
      }
    });
  });

  describe('POST /api/drafts/[id]/undo-reject', () => {
    // STAQPRO-331 #9 — operator-initiated undo of a fresh reject. Flips
    // rejected → pending and removes the latest draft_feedback row in one
    // transaction; writes a state_transitions audit row via session GUCs.

    it('flips rejected → pending and removes the latest draft_feedback row', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        // First reject so we have a row in draft_feedback to remove.
        const { POST: rejectPOST } = await import('@/app/api/drafts/[id]/reject/route');
        const rejectRes = await rejectPOST(fakeRequest({ body: { reason_code: 'wrong_tone' } }), {
          params: { id: String(seed.draftId) },
        });
        expect(rejectRes.status).toBe(200);
        const afterReject = await getDraftRow(seed.draftId);
        expect(afterReject?.status).toBe('rejected');

        const { getKysely } = await import('@/lib/db');
        const fbBefore = await getKysely()
          .selectFrom('draft_feedback')
          .selectAll()
          .where('draft_id', '=', seed.draftId)
          .execute();
        expect(fbBefore).toHaveLength(1);

        const { POST: undoPOST } = await import('@/app/api/drafts/[id]/undo-reject/route');
        const undoRes = await undoPOST(fakeRequest({ body: {} }), {
          params: { id: String(seed.draftId) },
        });
        expect(undoRes.status).toBe(200);
        const afterUndo = await getDraftRow(seed.draftId);
        expect(afterUndo?.status).toBe('pending');

        const fbAfter = await getKysely()
          .selectFrom('draft_feedback')
          .selectAll()
          .where('draft_id', '=', seed.draftId)
          .execute();
        expect(fbAfter).toHaveLength(0);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 409 when draft is not in rejected state', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/undo-reject/route');
        const res = await POST(fakeRequest({ body: {} }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(409);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('pending'); // unchanged

        // No draft_feedback rows existed; ensure none were created/touched.
        const { getKysely } = await import('@/lib/db');
        const fb = await getKysely()
          .selectFrom('draft_feedback')
          .selectAll()
          .where('draft_id', '=', seed.draftId)
          .execute();
        expect(fb).toHaveLength(0);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it("writes a state_transitions row with actor='operator' reason='undo_reject'", async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST: rejectPOST } = await import('@/app/api/drafts/[id]/reject/route');
        await rejectPOST(fakeRequest({ body: { reason_code: 'wrong_tone' } }), {
          params: { id: String(seed.draftId) },
        });
        const { POST: undoPOST } = await import('@/app/api/drafts/[id]/undo-reject/route');
        const res = await undoPOST(fakeRequest({ body: {} }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(200);

        const latest = await getLatestTransition(seed.draftId);
        expect(latest).not.toBeNull();
        expect(latest?.from_status).toBe('rejected');
        expect(latest?.to_status).toBe('pending');
        expect(latest?.actor).toBe('operator');
        expect(latest?.reason).toBe('undo_reject');
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('is idempotent — second undo returns 409 without further mutation', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST: rejectPOST } = await import('@/app/api/drafts/[id]/reject/route');
        await rejectPOST(fakeRequest({ body: { reason_code: 'wrong_tone' } }), {
          params: { id: String(seed.draftId) },
        });
        const { POST: undoPOST } = await import('@/app/api/drafts/[id]/undo-reject/route');
        const first = await undoPOST(fakeRequest({ body: {} }), {
          params: { id: String(seed.draftId) },
        });
        expect(first.status).toBe(200);
        const second = await undoPOST(fakeRequest({ body: {} }), {
          params: { id: String(seed.draftId) },
        });
        expect(second.status).toBe(409);

        // Confirm draft is still 'pending' (first undo's terminal state) and
        // no additional draft_feedback rows were created/removed.
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('pending');
        const { getKysely } = await import('@/lib/db');
        const fb = await getKysely()
          .selectFrom('draft_feedback')
          .selectAll()
          .where('draft_id', '=', seed.draftId)
          .execute();
        expect(fb).toHaveLength(0);
      } finally {
        await deleteSeededDraft(seed);
      }
    });
  });

  // STAQPRO-331 #2 — surface drafts.rag_context_refs + rag_retrieval_reason as
  // resolved source messages (sender/subject/excerpt/sent_at). Qdrant is the
  // only place the payload lives, so the route round-trips through it; tests
  // mock fetch to return Qdrant-shaped responses.
  describe('GET /api/drafts/[id]/rag-refs', () => {
    it('returns 404 for nonexistent draft', async () => {
      const { GET } = await import('@/app/api/drafts/[id]/rag-refs/route');
      const res = await GET(fakeRequest(), { params: { id: '999999999' } });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('draft_not_found');
    });

    it('returns reason + empty refs when rag_context_refs is empty (no Qdrant call)', async () => {
      const seed = await seedDraft({ ragContextRefs: [], ragRetrievalReason: 'no_hits' });
      // Track fetch calls so we can assert Qdrant was NOT hit on the empty path.
      const fetchSpy = vi.mocked(global.fetch);
      const callsBefore = fetchSpy.mock.calls.length;
      try {
        const { GET } = await import('@/app/api/drafts/[id]/rag-refs/route');
        const res = await GET(fakeRequest(), { params: { id: String(seed.draftId) } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.reason).toBe('no_hits');
        expect(body.refs).toEqual([]);
        // Sanity check: no Qdrant fetch issued for the empty-refs branch.
        expect(fetchSpy.mock.calls.length).toBe(callsBefore);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('resolves stored point IDs to Qdrant payloads and preserves stored ORDER', async () => {
      // Stored order in rag_context_refs is the order the drafter saw them.
      // Qdrant batch-get does NOT guarantee response ordering — the route
      // re-orders by stored point_id. Test that explicitly with a Qdrant
      // mock that returns the points in reverse order.
      const A = '11111111-1111-4111-8111-111111111111';
      const B = '22222222-2222-4222-8222-222222222222';
      const seed = await seedDraft({
        ragContextRefs: [A, B], // stored order: A, B
        ragRetrievalReason: 'ok',
      });
      const fetchSpy = vi.mocked(global.fetch);
      fetchSpy.mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              result: [
                // Qdrant returns B first to prove the route re-orders.
                {
                  id: B,
                  payload: {
                    message_id: 'msg-B',
                    sender: 'b@example.com',
                    recipient: 'op@example.com',
                    subject: 'subject B',
                    body_excerpt: 'body excerpt B',
                    sent_at: '2026-05-01T12:00:00Z',
                    direction: 'inbound',
                    classification_category: 'reorder',
                  },
                },
                {
                  id: A,
                  payload: {
                    message_id: 'msg-A',
                    sender: 'a@example.com',
                    recipient: 'op@example.com',
                    subject: 'subject A',
                    body_excerpt: 'body excerpt A',
                    sent_at: '2026-05-02T12:00:00Z',
                    direction: 'outbound',
                    classification_category: null,
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      );
      try {
        const { GET } = await import('@/app/api/drafts/[id]/rag-refs/route');
        const res = await GET(fakeRequest(), { params: { id: String(seed.draftId) } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.reason).toBe('ok');
        expect(body.refs).toHaveLength(2);
        // Stored order (A, B) wins, NOT Qdrant response order (B, A).
        expect(body.refs[0].point_id).toBe(A);
        expect(body.refs[0].message_id).toBe('msg-A');
        expect(body.refs[1].point_id).toBe(B);
        expect(body.refs[1].sender).toBe('b@example.com');
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns qdrant_error + unresolved_point_ids when Qdrant is unreachable', async () => {
      const A = '33333333-3333-4333-8333-333333333333';
      const seed = await seedDraft({
        ragContextRefs: [A],
        ragRetrievalReason: 'ok',
      });
      const fetchSpy = vi.mocked(global.fetch);
      fetchSpy.mockImplementationOnce(() =>
        Promise.resolve(new Response('service unavailable', { status: 503 })),
      );
      try {
        const { GET } = await import('@/app/api/drafts/[id]/rag-refs/route');
        const res = await GET(fakeRequest(), { params: { id: String(seed.draftId) } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.refs).toEqual([]);
        expect(body.qdrant_error).toMatch(/503/);
        expect(body.unresolved_point_ids).toEqual([A]);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    // STAQPRO-333 — surface drafts.kb_context_refs as resolved KB chunks
    // (doc_title / excerpt / uploaded_at) alongside email refs. The drafter
    // already persists both kinds of refs; these cases prove the route
    // resolves them against the right Qdrant collection and tags them with
    // the correct source discriminator.
    it('resolves KB refs against the kb_documents collection (source-tagged, kb-only draft)', async () => {
      const KA = '44444444-4444-4444-8444-444444444444';
      const KB = '55555555-5555-4555-8555-555555555555';
      const seed = await seedDraft({
        ragContextRefs: [], // no email refs
        kbContextRefs: [KA, KB], // 2 kb refs in stored order
        ragRetrievalReason: 'no_hits', // email side had no hits
      });
      const fetchSpy = vi.mocked(global.fetch);
      // Only ONE fetch fires (KB batch-get) — email side has zero refs so skips.
      fetchSpy.mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              result: [
                {
                  id: KA,
                  payload: {
                    doc_id: 101,
                    chunk_index: 3,
                    doc_title: 'pricing-2026.pdf',
                    doc_sha256: 'abc',
                    mime_type: 'application/pdf',
                    excerpt: 'Standard rate is $0.42/unit; bulk over 1000 is $0.38/unit.',
                    uploaded_at: '2026-05-01T09:00:00Z',
                  },
                },
                {
                  id: KB,
                  payload: {
                    doc_id: 102,
                    chunk_index: 0,
                    doc_title: 'refund-policy.md',
                    doc_sha256: 'def',
                    mime_type: 'text/markdown',
                    excerpt: 'Refunds within 30 days of delivery, no questions asked.',
                    uploaded_at: '2026-05-02T10:00:00Z',
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      );
      try {
        const { GET } = await import('@/app/api/drafts/[id]/rag-refs/route');
        const res = await GET(fakeRequest(), { params: { id: String(seed.draftId) } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.reason).toBe('no_hits'); // email reason carried through
        expect(body.refs).toHaveLength(2);
        expect(body.refs[0]).toMatchObject({
          source: 'kb',
          point_id: KA,
          doc_id: 101,
          doc_title: 'pricing-2026.pdf',
          chunk_index: 3,
        });
        expect(body.refs[1]).toMatchObject({
          source: 'kb',
          point_id: KB,
          doc_id: 102,
          doc_title: 'refund-policy.md',
        });
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('resolves a mixed draft (email + kb refs) with email-first stable ordering', async () => {
      const E = '66666666-6666-4666-8666-666666666666';
      const K = '77777777-7777-4777-8777-777777777777';
      const seed = await seedDraft({
        ragContextRefs: [E],
        kbContextRefs: [K],
        ragRetrievalReason: 'ok',
      });
      const fetchSpy = vi.mocked(global.fetch);
      // Two fetches fire — order depends on Promise.all internals. Mock both
      // with mockImplementation (sticky) so either call order works.
      fetchSpy.mockImplementation((url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (u.includes('/collections/email_messages/points')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                result: [
                  {
                    id: E,
                    payload: {
                      message_id: 'msg-E',
                      sender: 'e@example.com',
                      recipient: 'op@example.com',
                      subject: 'subject E',
                      body_excerpt: 'body excerpt E',
                      sent_at: '2026-05-03T12:00:00Z',
                      direction: 'inbound',
                      classification_category: 'inquiry',
                    },
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (u.includes('/collections/kb_documents/points')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                result: [
                  {
                    id: K,
                    payload: {
                      doc_id: 200,
                      chunk_index: 1,
                      doc_title: 'SOP-onboarding.pdf',
                      doc_sha256: 'xyz',
                      mime_type: 'application/pdf',
                      excerpt: 'Onboarding takes ~30 days from signed agreement.',
                      uploaded_at: '2026-04-15T14:00:00Z',
                    },
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response('unexpected URL', { status: 500 }));
      });
      try {
        const { GET } = await import('@/app/api/drafts/[id]/rag-refs/route');
        const res = await GET(fakeRequest(), { params: { id: String(seed.draftId) } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.reason).toBe('ok');
        expect(body.refs).toHaveLength(2);
        // Email-first ordering invariant (D-3 in the plan).
        expect(body.refs[0].source).toBe('email');
        expect(body.refs[0].point_id).toBe(E);
        expect(body.refs[1].source).toBe('kb');
        expect(body.refs[1].point_id).toBe(K);
        expect(body.refs[1].doc_title).toBe('SOP-onboarding.pdf');
      } finally {
        await deleteSeededDraft(seed);
        // Reset fetch mock back to the suite's beforeAll default for any
        // following tests outside this describe block.
        vi.mocked(global.fetch).mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
        );
      }
    });
  });
});
