import { afterAll, describe, expect, it } from 'vitest';
import {
  closeTestPool,
  deleteSeededDraft,
  fakeRequest,
  getDraftRow,
  getTestPool,
  HAS_DB,
  seedDraft,
} from '../helpers/db';

// STAQPRO-133 v3 — pipeline smoke. Walks through the n8n-facing API chain
// in sequence (matching the order the live MailBOX-Classify and
// MailBOX-Draft sub-workflows call them):
//
//   1. /api/internal/classification-prompt   — n8n fetches the prompt
//   2. (run Ollama on n8n's side — faked via canned classifier JSON)
//   3. /api/internal/classification-normalize — n8n parses Ollama's output
//   4. (insert draft stub — matches Insert Draft Stub n8n node)
//   5. /api/internal/draft-prompt             — n8n fetches drafting prompt
//                                                + endpoint config
//   6. (run Ollama on n8n's side — faked via canned drafter body)
//   7. /api/internal/draft-finalize           — n8n persists the body
//   8. Verify final drafts row state.
//
// Real DB; canned LLM. Catches regressions in any single edge of the chain
// (e.g. a refactor that breaks the field shape `draft-finalize` expects).

const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('pipeline smoke — classify → draft API chain', () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it('walks fixture-inbox → finalized draft via the n8n-facing endpoints', async () => {
    // Seed an inbox-only row (no draft yet) — matches n8n's state right after
    // the `Insert Inbox (skip dupes)` node.
    const pool = getTestPool();
    const tag = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inbox = await pool.query<{ id: number }>(
      `INSERT INTO mailbox.inbox_messages
         (message_id, from_addr, to_addr, subject, body, received_at)
       VALUES ($1, 'sarah@example-cpg.com', 'op@example.com', $2,
               'Hi, can we reorder 200 cases for May 15? Same SKU. Thanks.',
               NOW())
       RETURNING id`,
      [tag, `Reorder request — ${tag}`],
    );
    const inboxMessageId = inbox.rows[0].id;
    let draftId: number | undefined;

    try {
      // 1. classification-prompt — n8n call to get the Qwen3 prompt
      const { POST: prompt } = await import('@/app/api/internal/classification-prompt/route');
      const promptRes = await prompt(
        fakeRequest({
          body: {
            from: 'sarah@example-cpg.com',
            subject: `Reorder request — ${tag}`,
            body: 'Hi, can we reorder 200 cases for May 15? Same SKU. Thanks.',
          },
        }),
      );
      expect(promptRes.status).toBe(200);
      const promptBody = (await promptRes.json()) as {
        prompt: string;
        model: string;
      };
      expect(promptBody.prompt).toContain('reorder');
      expect(promptBody.model).toBeTruthy();

      // 2. (n8n posts promptBody.prompt to Ollama; here we fake the response)
      const fakeClassifierOutput = JSON.stringify({
        category: 'reorder',
        confidence: 0.93,
      });

      // 3. classification-normalize — n8n calls this with Ollama's raw output
      const { POST: normalize } = await import('@/app/api/internal/classification-normalize/route');
      const normRes = await normalize(
        fakeRequest({
          body: {
            raw: fakeClassifierOutput,
            from: 'sarah@example-cpg.com',
            to: 'op@example.com',
          },
        }),
      );
      expect(normRes.status).toBe(200);
      const normBody = (await normRes.json()) as {
        category: string;
        confidence: number;
        json_parse_ok: boolean;
      };
      expect(normBody.category).toBe('reorder');
      expect(normBody.confidence).toBeCloseTo(0.93, 2);
      expect(normBody.json_parse_ok).toBe(true);

      // 4. Insert draft stub — mirrors what n8n's Insert Draft Stub node does
      //    (carries classification_category + confidence onto the draft row).
      const stub = await pool.query<{ id: number }>(
        `INSERT INTO mailbox.drafts
           (inbox_message_id, draft_body, model, status,
            classification_category, classification_confidence,
            from_addr, to_addr, subject, body_text, received_at)
         VALUES ($1, '(awaiting draft)', 'pending-stub', 'pending',
                 $2, $3,
                 'sarah@example-cpg.com', 'op@example.com', $4,
                 'Hi, can we reorder 200 cases for May 15? Same SKU. Thanks.',
                 NOW())
         RETURNING id`,
        [inboxMessageId, normBody.category, normBody.confidence, `Reorder request — ${tag}`],
      );
      draftId = stub.rows[0].id;

      // 5. draft-prompt — n8n call to assemble drafting prompt + endpoint
      const { POST: draftPrompt } = await import('@/app/api/internal/draft-prompt/route');
      const dpRes = await draftPrompt(fakeRequest({ body: { draft_id: draftId } }));
      expect(dpRes.status).toBe(200);
      const dpBody = (await dpRes.json()) as {
        draft_id: number;
        baseUrl: string;
        model: string;
        source: 'local' | 'cloud';
        messages: ReadonlyArray<{ role: string; content: string }>;
      };
      expect(dpBody.draft_id).toBe(draftId);
      expect(dpBody.source).toBe('local'); // 'reorder' @ 0.93 → local route
      expect(dpBody.baseUrl).toBeTruthy();
      expect(dpBody.model).toBeTruthy();
      expect(Array.isArray(dpBody.messages)).toBe(true);
      expect(dpBody.messages.length).toBeGreaterThan(0);

      // 6. (n8n posts dpBody.messages to dpBody.baseUrl; we fake the body)
      const fakeDrafterBody =
        'Hi Sarah,\n\nThanks for the reorder — confirming 200 cases for May 15. PO to follow shortly.\n\nBest,\nOps';

      // 7. draft-finalize — n8n posts the body back; route persists + costs it
      const { POST: finalize } = await import('@/app/api/internal/draft-finalize/route');
      const finRes = await finalize(
        fakeRequest({
          body: {
            draft_id: draftId,
            body: fakeDrafterBody,
            source: dpBody.source,
            model: dpBody.model,
            input_tokens: 320,
            output_tokens: 88,
          },
        }),
      );
      expect(finRes.status).toBe(200);
      const finBody = (await finRes.json()) as {
        ok: boolean;
        draft_id: number;
        cost_usd: number | string;
      };
      expect(finBody.ok).toBe(true);
      expect(finBody.draft_id).toBe(draftId);

      // 8. Verify the draft row reflects the full pipeline state.
      const row = await getDraftRow(draftId);
      expect(row).not.toBeNull();
      expect(row?.status).toBe('pending'); // finalize keeps status (operator approves later)
      expect(row?.draft_body).toBe(fakeDrafterBody);
    } finally {
      if (draftId !== undefined) {
        await deleteSeededDraft({ draftId, inboxMessageId });
      } else {
        // No draft was created; clean up the inbox row directly.
        const pool = getTestPool();
        await pool.query('DELETE FROM mailbox.inbox_messages WHERE id = $1', [inboxMessageId]);
      }
    }
  });

  it('classify normalize falls back to unknown on bad JSON', async () => {
    const { POST: normalize } = await import('@/app/api/internal/classification-normalize/route');
    const res = await normalize(fakeRequest({ body: { raw: 'not json at all', from: 'x@y.z' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      category: string;
      confidence: number;
      json_parse_ok: boolean;
    };
    expect(body.category).toBe('unknown');
    expect(body.confidence).toBe(0);
    expect(body.json_parse_ok).toBe(false);
  });

  it('draft-prompt routes high-confidence escalate to cloud', async () => {
    const seed = await seedDraft({ status: 'pending', classification: 'escalate' });
    try {
      const { POST: draftPrompt } = await import('@/app/api/internal/draft-prompt/route');
      const res = await draftPrompt(fakeRequest({ body: { draft_id: seed.draftId } }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { source: 'local' | 'cloud' };
      expect(body.source).toBe('cloud');
    } finally {
      await deleteSeededDraft(seed);
    }
  });
});
