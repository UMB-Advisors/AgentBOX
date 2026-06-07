// dashboard/test/lib/action-items-extract.test.ts
//
// MBOX-131 — unit tests for the action-item extraction parser
// (lib/drafting/action-items.ts:extractActionItems). HTTP is exercised via a
// stubbed global fetch so the suite is hermetic — no outbound network.
//
// Focus: the defensive parse path — enum clamping, malformed-item drop, and
// the non-gating fallback to [] on timeout / network / unparseable output.
// extractActionItems must NEVER throw.

import { afterEach, describe, expect, it, vi } from 'vitest';

// extractActionItems imports pickEndpoint from lib/drafting/router.ts, which
// transitively imports the private @umb-advisors/llm package (the DR-25 llama
// runtime helpers). That package isn't installed in the test sandbox, so stub
// it — these tests always pass an explicit `endpoint`, so the router's
// llm-runtime helpers are never actually exercised.
vi.mock('@umb-advisors/llm', () => ({
  readLlamaCppModel: () => 'stub-model',
  readOllamaBaseUrl: () => 'http://ollama.test:11434',
  readRuntimeKind: () => 'ollama',
}));

import { extractActionItems } from '@/lib/drafting/action-items';
import type { DraftEndpoint } from '@/lib/drafting/router';

const ENDPOINT: DraftEndpoint = {
  source: 'local',
  baseUrl: 'http://ollama.test:11434',
  apiKey: '',
  model: 'qwen3:4b-ctx4k',
  display_label: 'test',
};

const INBOUND = {
  from_addr: 'eric@staqs.io',
  subject: 'Reorder + call',
  body_text: 'Can you ship by Friday and call me Tuesday?',
  classification_category: 'reorder',
  classification_confidence: 0.9,
};

// Ollama /api/chat response shape: { message: { role, content } }.
function ollamaResponse(content: string, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ message: { role: 'assistant', content } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function stubFetch(fn: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(fn));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractActionItems — happy path', () => {
  it('parses a well-formed JSON array into ActionItems', async () => {
    stubFetch(() =>
      Promise.resolve(
        ollamaResponse(
          JSON.stringify([
            {
              text: 'Ship the reorder by Friday.',
              type: 'deadline',
              due_at: '2026-05-29T17:00:00Z',
              source: 'outbound',
              confidence: 0.9,
            },
            {
              text: 'Eric wants a call Tuesday.',
              type: 'meeting',
              due_at: null,
              source: 'inbound',
              confidence: 0.7,
            },
          ]),
        ),
      ),
    );
    const items = await extractActionItems({
      draftId: 1,
      draftBody: 'Will ship Friday; happy to call Tuesday.',
      inbound: INBOUND,
      endpoint: ENDPOINT,
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: 'deadline', source: 'outbound' });
    expect(items[0].due_at).toBe('2026-05-29T17:00:00.000Z'); // normalized to ISO
    expect(items[1]).toMatchObject({ type: 'meeting', source: 'inbound', due_at: null });
  });

  it('tolerates prose / markdown fences around the JSON array', async () => {
    stubFetch(() =>
      Promise.resolve(
        ollamaResponse(
          'Here are the items:\n```json\n[{"text":"Send PO","type":"request","due_at":null,"source":"inbound","confidence":0.8}]\n```\nThat is all.',
        ),
      ),
    );
    const items = await extractActionItems({
      draftId: 2,
      draftBody: 'reply',
      inbound: INBOUND,
      endpoint: ENDPOINT,
    });
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('Send PO');
  });
});

describe('extractActionItems — clamp + drop', () => {
  it('drops items with an out-of-set type or source (no coercion)', async () => {
    stubFetch(() =>
      Promise.resolve(
        ollamaResponse(
          JSON.stringify([
            { text: 'bad type', type: 'todo', due_at: null, source: 'inbound', confidence: 0.5 },
            { text: 'bad source', type: 'request', due_at: null, source: 'self', confidence: 0.5 },
            { text: 'good', type: 'commitment', due_at: null, source: 'outbound', confidence: 0.5 },
          ]),
        ),
      ),
    );
    const items = await extractActionItems({
      draftId: 3,
      draftBody: 'reply',
      inbound: INBOUND,
      endpoint: ENDPOINT,
    });
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('good');
  });

  it('clamps confidence into [0,1] and drops empty / non-string text', async () => {
    stubFetch(() =>
      Promise.resolve(
        ollamaResponse(
          JSON.stringify([
            { text: 'over', type: 'request', due_at: null, source: 'inbound', confidence: 5 },
            { text: 'under', type: 'request', due_at: null, source: 'inbound', confidence: -2 },
            { text: '   ', type: 'request', due_at: null, source: 'inbound', confidence: 0.5 },
            { text: 42, type: 'request', due_at: null, source: 'inbound', confidence: 0.5 },
          ]),
        ),
      ),
    );
    const items = await extractActionItems({
      draftId: 4,
      draftBody: 'reply',
      inbound: INBOUND,
      endpoint: ENDPOINT,
    });
    expect(items).toHaveLength(2); // empty + non-string text dropped
    expect(items[0].confidence).toBe(1);
    expect(items[1].confidence).toBe(0);
  });

  it('coerces a bad due_at to null without throwing', async () => {
    stubFetch(() =>
      Promise.resolve(
        ollamaResponse(
          JSON.stringify([
            {
              text: 'x',
              type: 'deadline',
              due_at: 'not-a-date',
              source: 'outbound',
              confidence: 0.9,
            },
          ]),
        ),
      ),
    );
    const items = await extractActionItems({
      draftId: 5,
      draftBody: 'reply',
      inbound: INBOUND,
      endpoint: ENDPOINT,
    });
    expect(items).toHaveLength(1);
    expect(items[0].due_at).toBeNull();
  });
});

describe('extractActionItems — non-gating fallbacks (never throws)', () => {
  it('returns [] when the model output has no JSON array', async () => {
    stubFetch(() => Promise.resolve(ollamaResponse('I could not find any action items.')));
    const items = await extractActionItems({
      draftId: 6,
      draftBody: 'reply',
      inbound: INBOUND,
      endpoint: ENDPOINT,
    });
    expect(items).toEqual([]);
  });

  it('returns [] on a non-2xx model response', async () => {
    stubFetch(() => Promise.resolve(new Response('boom', { status: 500 })));
    const items = await extractActionItems({
      draftId: 7,
      draftBody: 'reply',
      inbound: INBOUND,
      endpoint: ENDPOINT,
    });
    expect(items).toEqual([]);
  });

  it('returns [] when the fetch rejects (network / timeout) — no throw', async () => {
    stubFetch(() => Promise.reject(new Error('network down')));
    await expect(
      extractActionItems({ draftId: 8, draftBody: 'reply', inbound: INBOUND, endpoint: ENDPOINT }),
    ).resolves.toEqual([]);
  });

  it('returns [] when the model returns valid JSON that is not an array', async () => {
    stubFetch(() => Promise.resolve(ollamaResponse('{"text":"oops"}')));
    const items = await extractActionItems({
      draftId: 9,
      draftBody: 'reply',
      inbound: INBOUND,
      endpoint: ENDPOINT,
    });
    expect(items).toEqual([]);
  });
});
