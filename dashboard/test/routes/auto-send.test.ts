import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeTestPool,
  deleteSeededDraft,
  fakeRequest,
  getDraftStatus,
  getLatestTransition,
  getTestPool,
  HAS_DB,
  type SeededDraft,
  seedDraft,
} from '../helpers/db';

// MBOX-16 / FR-23 — auto-send CRUD + the draft-finalize integration. DB-backed:
// skips without TEST_POSTGRES_URL (same gate as the other route suites). The
// pure evaluator is covered separately in test/lib/auto-send-rules.test.ts.

const dbDescribe = HAS_DB ? describe : describe.skip;

// Clean the rules table between cases so the no-match/default tests aren't
// polluted by rules a prior case created.
async function clearRules(): Promise<void> {
  const pool = getTestPool();
  await pool.query('DELETE FROM mailbox.auto_send_rules');
}

async function auditRows(
  draftId: number,
): Promise<
  Array<{ matched_action: string; effective_action: string; shadow: boolean; reason: string }>
> {
  const pool = getTestPool();
  const r = await pool.query(
    `SELECT matched_action, effective_action, shadow, reason
       FROM mailbox.auto_send_audit WHERE draft_id = $1 ORDER BY evaluated_at DESC`,
    [draftId],
  );
  return r.rows;
}

dbDescribe('auto-send rules — real Postgres', () => {
  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(async () => {
    await clearRules();
  });

  afterEach(async () => {
    // Clear rules AFTER each test too (not just before) so the LAST test's
    // rule never leaks past this file. Files share one Postgres (serial per
    // vitest.config fileParallelism:false); a leftover `auto_send` rule would
    // otherwise auto-approve another file's `reorder` draft — e.g.
    // pipeline-smoke, which asserts the finalized draft stays `pending`.
    await clearRules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('CRUD routes', () => {
    it('creates, lists, updates, and deletes a rule', async () => {
      const { POST, GET } = await import('@/app/api/auto-send-rules/route');

      const createRes = await POST(
        fakeRequest({
          body: { name: 'auto reorder', action: 'auto_send', category: 'reorder' },
        }),
      );
      expect(createRes.status).toBe(201);
      const { rule } = (await createRes.json()) as { rule: { id: number; action: string } };
      expect(rule.action).toBe('auto_send');

      const listRes = await GET();
      const { rules } = (await listRes.json()) as { rules: Array<{ id: number }> };
      expect(rules.some((r) => r.id === rule.id)).toBe(true);

      const { PATCH, DELETE } = await import('@/app/api/auto-send-rules/[id]/route');
      const patchRes = await PATCH(fakeRequest({ body: { enabled: false } }), {
        params: { id: String(rule.id) },
      });
      expect(patchRes.status).toBe(200);
      const patched = (await patchRes.json()) as { rule: { enabled: boolean } };
      expect(patched.rule.enabled).toBe(false);

      const delRes = await DELETE(fakeRequest({}), { params: { id: String(rule.id) } });
      expect(delRes.status).toBe(200);
    });

    it('rejects an invalid action with a 400', async () => {
      const { POST } = await import('@/app/api/auto-send-rules/route');
      const res = await POST(fakeRequest({ body: { name: 'x', action: 'nuke' } }));
      expect(res.status).toBe(400);
    });

    it('404s deleting a nonexistent rule', async () => {
      const { DELETE } = await import('@/app/api/auto-send-rules/[id]/route');
      const res = await DELETE(fakeRequest({}), { params: { id: '999999999' } });
      expect(res.status).toBe(404);
    });
  });

  describe('draft-finalize auto-send integration', () => {
    let seeded: SeededDraft;

    beforeEach(async () => {
      // reorder / 0.92 confidence / sender@example.com — would auto-send under a
      // permissive rule.
      seeded = await seedDraft({ classification: 'reorder' });
    });

    afterEach(async () => {
      if (seeded) await deleteSeededDraft(seeded);
    });

    async function finalize(): Promise<{
      auto_send: { effective_action: string; sent: boolean; shadow: boolean };
    }> {
      const { POST } = await import('@/app/api/internal/draft-finalize/route');
      const res = await POST(
        fakeRequest({
          body: {
            draft_id: seeded.draftId,
            body: 'finalized reply body',
            source: 'local',
            model: 'qwen3:4b-ctx4k',
            input_tokens: 10,
            output_tokens: 20,
          },
        }),
      );
      return (await res.json()) as {
        auto_send: { effective_action: string; sent: boolean; shadow: boolean };
      };
    }

    it('default-safe: with NO rules the draft stays pending and no audit row is written', async () => {
      const out = await finalize();
      expect(out.auto_send.effective_action).toBe('queue');
      expect(out.auto_send.sent).toBe(false);
      expect(await getDraftStatus(seeded.draftId)).toBe('pending');
      expect(await auditRows(seeded.draftId)).toHaveLength(0);
    });

    it('drop rule: rejects the draft and writes a drop audit row', async () => {
      const { POST } = await import('@/app/api/auto-send-rules/route');
      await POST(
        fakeRequest({ body: { name: 'drop reorder', action: 'drop', category: 'reorder' } }),
      );

      const out = await finalize();
      expect(out.auto_send.effective_action).toBe('drop');
      expect(await getDraftStatus(seeded.draftId)).toBe('rejected');
      const t = await getLatestTransition(seeded.draftId);
      expect(t?.to_status).toBe('rejected');
      expect(t?.actor).toBe('auto');
      const audit = await auditRows(seeded.draftId);
      expect(audit[0].effective_action).toBe('drop');
    });

    it('shadow auto_send rule: queues + records shadow audit (does NOT send)', async () => {
      const { POST } = await import('@/app/api/auto-send-rules/route');
      const shadowUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await POST(
        fakeRequest({
          body: {
            name: 'shadow reorder',
            action: 'auto_send',
            category: 'reorder',
            shadow_until: shadowUntil,
          },
        }),
      );

      const out = await finalize();
      expect(out.auto_send.effective_action).toBe('queue');
      expect(out.auto_send.shadow).toBeTruthy();
      expect(await getDraftStatus(seeded.draftId)).toBe('pending');
      const audit = await auditRows(seeded.draftId);
      expect(audit[0].matched_action).toBe('auto_send');
      expect(audit[0].effective_action).toBe('queue');
      expect(audit[0].shadow).toBe(true);
      expect(audit[0].reason).toBe('shadow_mode');
    });

    it('GUARDRAIL: an escalate auto_send rule never sends — queues with guardrail reason', async () => {
      // Re-seed as escalate for this case.
      await deleteSeededDraft(seeded);
      seeded = await seedDraft({ classification: 'escalate' });
      const { POST } = await import('@/app/api/auto-send-rules/route');
      await POST(
        fakeRequest({ body: { name: 'oops escalate', action: 'auto_send', category: 'escalate' } }),
      );

      const out = await finalize();
      expect(out.auto_send.effective_action).toBe('queue');
      expect(await getDraftStatus(seeded.draftId)).toBe('pending');
      const audit = await auditRows(seeded.draftId);
      expect(audit[0].reason).toBe('guardrail_escalate_category');
    });

    it('SAFETY: an active Gmail cooldown blocks auto-send — draft stays pending', async () => {
      const pool = getTestPool();
      // Arm the circuit breaker (transitionToApprovedAndSend refuses to send
      // while the (default account, 'gmail') mail_cooldowns row is in the future).
      await pool.query(
        `INSERT INTO mailbox.mail_cooldowns (account_id, provider, until, set_at)
         SELECT id, 'gmail', NOW() + interval '1 hour', NOW() FROM mailbox.accounts WHERE is_default
         ON CONFLICT (account_id, provider) DO UPDATE SET until = EXCLUDED.until, set_at = NOW()`,
      );
      // Stub the webhook so a regression that bypasses the cooldown would be
      // caught by an unexpected fetch (the gate should short-circuit first).
      // Typed with a fetch-shaped arg list so `mock.calls` carries the URL
      // argument — a no-arg `vi.fn()` gives empty call tuples and breaks the
      // `[input]` destructuring below under `tsc --noEmit`.
      const fetchSpy = vi.fn(
        async (..._args: Parameters<typeof fetch>) => new Response('{}', { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.stubEnv('N8N_WEBHOOK_URL', 'http://n8n.test/webhook/mailbox-send');

      const { POST } = await import('@/app/api/auto-send-rules/route');
      await POST(
        fakeRequest({ body: { name: 'send reorder', action: 'auto_send', category: 'reorder' } }),
      );

      const out = await finalize();
      // Cooldown 429 → not sent; draft remains queued for the operator.
      expect(out.auto_send.sent).toBe(false);
      expect(await getDraftStatus(seeded.draftId)).toBe('pending');
      // Scope the assertion to the SEND webhook specifically. draft-finalize
      // also fetches Ollama for MBOX-131 action-item extraction (non-gating,
      // runs before auto-send), so a blanket `not.toHaveBeenCalled()` would
      // false-positive on that unrelated call. What this test guards is that
      // the cooldown gate short-circuits BEFORE triggerSendWebhook fires.
      const sendWebhookCalls = fetchSpy.mock.calls.filter(([input]) =>
        String(input).includes('/webhook/mailbox-send'),
      );
      expect(sendWebhookCalls).toHaveLength(0);

      // Clean up the cooldown so it doesn't leak into other suites.
      await pool.query(
        `DELETE FROM mailbox.mail_cooldowns WHERE provider = 'gmail' AND account_id = (SELECT id FROM mailbox.accounts WHERE is_default)`,
      );
    });
  });
});
