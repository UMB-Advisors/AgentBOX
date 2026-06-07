import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { idParamSchema } from '@/lib/schemas/common';
import { editBodySchema, listDraftsQuerySchema, rejectBodySchema } from '@/lib/schemas/drafts';
import { draftFinalizeBodySchema, draftPromptBodySchema } from '@/lib/schemas/internal';
import { parseJson, parseParams, parseQuery } from './validate';

// Minimal NextRequest stand-in: parseJson only touches `.json()` and `.url`,
// so we can hand it a plain object that satisfies the same shape without
// pulling in a Next.js test harness.
function fakeReq({ body, url = 'http://test.local/api/x' }: { body?: unknown; url?: string }) {
  return {
    url,
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  } as unknown as Parameters<typeof parseJson>[0];
}

describe('parseParams (idParamSchema)', () => {
  it('coerces numeric string to positive integer', () => {
    const r = parseParams({ id: '42' }, idParamSchema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBe(42);
  });

  it('rejects non-numeric id with 400', () => {
    const r = parseParams({ id: 'abc' }, idParamSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  it('rejects zero and negative ids', async () => {
    for (const id of ['0', '-5']) {
      const r = parseParams({ id }, idParamSchema);
      expect(r.ok).toBe(false);
    }
  });
});

describe('parseQuery (listDraftsQuerySchema)', () => {
  it('defaults to status=[pending] when omitted', () => {
    const req = fakeReq({ url: 'http://t/api/drafts' }) as never;
    const r = parseQuery(req, listDraftsQuerySchema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.status).toEqual(['pending']);
      expect(r.data.limit).toBe(50);
    }
  });

  it('parses csv status list', () => {
    const req = fakeReq({
      url: 'http://t/api/drafts?status=pending,approved&limit=10',
    }) as never;
    const r = parseQuery(req, listDraftsQuerySchema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.status).toEqual(['pending', 'approved']);
      expect(r.data.limit).toBe(10);
    }
  });

  it('rejects unknown status with 400', () => {
    const req = fakeReq({
      url: 'http://t/api/drafts?status=bogus',
    }) as never;
    const r = parseQuery(req, listDraftsQuerySchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  it('rejects limit > 250', () => {
    const req = fakeReq({
      url: 'http://t/api/drafts?limit=999',
    }) as never;
    const r = parseQuery(req, listDraftsQuerySchema);
    expect(r.ok).toBe(false);
  });
});

describe('parseJson — drafts schemas', () => {
  // STAQPRO-331 #1 — reject body is now structured: { reason_code, free_text }.
  it('rejectBody rejects empty body (reason_code now required)', async () => {
    const r = await parseJson(fakeReq({ body: {} }), rejectBodySchema);
    expect(r.ok).toBe(false);
  });

  it('rejectBody accepts a valid reason_code without free_text', async () => {
    const r = await parseJson(fakeReq({ body: { reason_code: 'wrong_tone' } }), rejectBodySchema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.reason_code).toBe('wrong_tone');
      expect(r.data.free_text).toBeNull();
    }
  });

  it('rejectBody trims free_text and accepts non-empty', async () => {
    const r = await parseJson(
      fakeReq({ body: { reason_code: 'wrong_tone', free_text: '  not on brand  ' } }),
      rejectBodySchema,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.free_text).toBe('not on brand');
  });

  it("rejectBody requires free_text when reason_code is 'other'", async () => {
    const r = await parseJson(fakeReq({ body: { reason_code: 'other' } }), rejectBodySchema);
    expect(r.ok).toBe(false);
  });

  it("rejectBody 'other' with non-empty free_text passes", async () => {
    const r = await parseJson(
      fakeReq({ body: { reason_code: 'other', free_text: 'tone was odd' } }),
      rejectBodySchema,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.free_text).toBe('tone was odd');
  });

  it('rejectBody rejects unknown reason_code', async () => {
    const r = await parseJson(fakeReq({ body: { reason_code: 'gibberish' } }), rejectBodySchema);
    expect(r.ok).toBe(false);
  });

  it('editBody requires non-empty draft_body', async () => {
    const r = await parseJson(fakeReq({ body: { draft_body: '   ' } }), editBodySchema);
    expect(r.ok).toBe(false);
  });

  it('editBody rejects body over 10_000 chars', async () => {
    const r = await parseJson(
      fakeReq({ body: { draft_body: 'x'.repeat(10_001) } }),
      editBodySchema,
    );
    expect(r.ok).toBe(false);
  });

  it('editBody preserves draft_body verbatim, nulls missing subject', async () => {
    const r = await parseJson(
      fakeReq({ body: { draft_body: 'Hi Eric,\n\nThanks.' } }),
      editBodySchema,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.draft_body).toBe('Hi Eric,\n\nThanks.');
      expect(r.data.draft_subject).toBeNull();
    }
  });
});

describe('parseJson — internal schemas', () => {
  it('draftPromptBody requires positive draft_id', async () => {
    expect((await parseJson(fakeReq({ body: {} }), draftPromptBodySchema)).ok).toBe(false);
    expect((await parseJson(fakeReq({ body: { draft_id: 0 } }), draftPromptBodySchema)).ok).toBe(
      false,
    );
    const r = await parseJson(fakeReq({ body: { draft_id: 17 } }), draftPromptBodySchema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.draft_id).toBe(17);
  });

  it('draftFinalizeBody coerces string token counts (n8n compatibility)', async () => {
    const r = await parseJson(
      fakeReq({
        body: {
          draft_id: 17,
          body: 'A reply.',
          source: 'local',
          model: 'qwen3:4b-ctx4k',
          input_tokens: '120',
          output_tokens: '64',
        },
      }),
      draftFinalizeBodySchema,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.input_tokens).toBe(120);
      expect(r.data.output_tokens).toBe(64);
    }
  });

  it('draftFinalizeBody rejects unknown source', async () => {
    const r = await parseJson(
      fakeReq({
        body: {
          draft_id: 1,
          body: 'X',
          source: 'magic',
          model: 'm',
        },
      }),
      draftFinalizeBodySchema,
    );
    expect(r.ok).toBe(false);
  });

  it('draftFinalizeBody defaults missing token fields to 0', async () => {
    const r = await parseJson(
      fakeReq({
        body: {
          draft_id: 1,
          body: 'X',
          source: 'cloud',
          model: 'gpt-oss:120b',
        },
      }),
      draftFinalizeBodySchema,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.input_tokens).toBe(0);
      expect(r.data.output_tokens).toBe(0);
    }
  });
});

describe('parseJson error response shape', () => {
  it('emits 400 with { error: validation_failed, issues: [...] }', async () => {
    const r = await parseJson(
      fakeReq({ body: { draft_id: 'not-a-number' } }),
      draftPromptBodySchema,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(400);
      const json = (await r.response.json()) as {
        error: string;
        issues: ReadonlyArray<{ path: string }>;
      };
      expect(json.error).toBe('validation_failed');
      expect(json.issues.length).toBeGreaterThan(0);
      expect(json.issues[0].path).toContain('draft_id');
    }
  });

  it('treats missing/invalid JSON body as {} — schema with required fields fails', async () => {
    const fake = {
      url: 'http://t/x',
      json: async () => {
        throw new Error('not JSON');
      },
    } as unknown as Parameters<typeof parseJson>[0];
    const schema = z.object({ x: z.string() });
    const r = await parseJson(fake, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  it('treats missing JSON body as {} — schema with required fields fails', async () => {
    // STAQPRO-331 #1 — rejectBodySchema now requires reason_code, so an
    // empty body should fail. Switching to listDraftsQuerySchema-shape via
    // an inline z.object would be overkill; reuse rejectBodySchema and
    // assert it does correctly reject the empty fallback.
    const fake = {
      url: 'http://t/x',
      json: async () => {
        throw new Error('not JSON');
      },
    } as unknown as Parameters<typeof parseJson>[0];
    const r = await parseJson(fake, rejectBodySchema);
    expect(r.ok).toBe(false);
  });
});
