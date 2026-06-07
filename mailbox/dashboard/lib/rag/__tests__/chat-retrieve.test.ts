// dashboard/lib/rag/__tests__/chat-retrieve.test.ts
//
// MBOX-283 — query-scoped chat retrieval with a relevance floor.
//
// Contract under test (retrieveForChat):
//   - embeds the chat query and runs ONE query-scoped Qdrant search (no
//     sender/recipient/persona/self/thread filters — unlike the draft path)
//   - applies CHAT_RETRIEVE_SCORE_FLOOR: below-floor-only → empty + 'below_floor'
//   - thin corpus (empty Qdrant result) → empty + 'no_hits'
//   - rich corpus → ranked, above-floor refs + 'ok'
//   - embed/Qdrant outage → success-shaped empty result (RAG is augmentation)
//
// Mocking mirrors the sibling retrieve.test.ts: stub global fetch, branch on
// the URL for /api/embeddings vs /collections/email_messages/points/search.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retrieveForChat } from '../chat-retrieve';

interface MockOpts {
  hits?: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
  // null → embed call returns a non-200 (embed_unavailable path).
  embedFails?: boolean;
  // null → search call returns a non-200 (qdrant_unavailable path).
  searchFails?: boolean;
  // Captures the parsed search request body so a test can assert the filter
  // shape (chat search must NOT send sender/persona/self filters).
  capturedSearchBody?: { value: unknown };
}

function mockEmbedAndSearch(opts: MockOpts) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/embeddings')) {
      if (opts.embedFails) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ embedding: new Array(768).fill(0.01) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/collections/email_messages/points/search')) {
      if (opts.searchFails) return new Response('boom', { status: 500 });
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (opts.capturedSearchBody) opts.capturedSearchBody.value = body;
      return new Response(JSON.stringify({ result: opts.hits ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function hit(id: string, score: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    score,
    payload: {
      message_id: `msg-${id}`,
      sender: 'someone@example.com',
      subject: 'subject',
      body_excerpt: `excerpt for ${id}`,
      sent_at: '2026-04-01T09:00:00Z',
      direction: 'inbound',
      ...extra,
    },
  };
}

describe('retrieveForChat — MBOX-283', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.OLLAMA_BASE_URL = 'http://test-ollama:11434';
    process.env.QDRANT_URL = 'http://test-qdrant:6333';
    delete process.env.CHAT_RETRIEVE_TOP_K;
    delete process.env.CHAT_RETRIEVE_SCORE_FLOOR;
    delete process.env.RAG_RETRIEVE_EXCERPT_CHARS;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("empty/whitespace query short-circuits to 'empty_query' without touching infra", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('should not be called — empty query must short-circuit');
    }) as unknown as typeof fetch;

    const r = await retrieveForChat('   ');
    expect(r.reason).toBe('empty_query');
    expect(r.refs).toEqual([]);
  });

  it('query-scoped search sends NO sender/persona/self filters (unlike the draft path)', async () => {
    const captured: { value: unknown } = { value: null };
    mockEmbedAndSearch({ hits: [], capturedSearchBody: captured });

    await retrieveForChat('what did the supplier say about the Q3 delay?');

    const body = captured.value as { filter?: unknown; limit?: number } | null;
    // No filter at all — chat is corpus-wide.
    expect(body?.filter).toBeUndefined();
    // Default top-k is 4.
    expect(body?.limit).toBe(4);
  });

  it('account-scoped query sends the account_id hard filter (MBOX-400 isolation)', async () => {
    const captured: { value: unknown } = { value: null };
    mockEmbedAndSearch({ hits: [], capturedSearchBody: captured });

    await retrieveForChat('what did we agree on?', 7);

    const body = captured.value as {
      filter?: { must?: Array<{ key: string; match: { value: number } }> };
    } | null;
    // The ONLY must-clause is the account filter — no sender/persona/thread
    // filters leak in (chat stays query-scoped within the inbox).
    expect(body?.filter?.must).toEqual([{ key: 'account_id', match: { value: 7 } }]);
  });

  it('omitted accountId stays corpus-wide (back-compat for eval/harness callers)', async () => {
    const captured: { value: unknown } = { value: null };
    mockEmbedAndSearch({ hits: [], capturedSearchBody: captured });

    await retrieveForChat('corpus-wide question');

    expect((captured.value as { filter?: unknown } | null)?.filter).toBeUndefined();
  });

  it("rich corpus → ranked above-floor refs with reason 'ok'", async () => {
    mockEmbedAndSearch({
      hits: [hit('a', 0.91), hit('b', 0.78), hit('c', 0.7)],
    });

    const r = await retrieveForChat('Q3 shipment status');
    expect(r.reason).toBe('ok');
    expect(r.refs.map((x) => x.point_id)).toEqual(['a', 'b', 'c']);
    // Shape: point_id + message_id + excerpt + score (287 needs all four).
    expect(r.refs[0]).toMatchObject({
      point_id: 'a',
      message_id: 'msg-a',
      excerpt: 'excerpt for a',
      score: 0.91,
    });
  });

  it("thin corpus (Qdrant returns nothing) → empty + 'no_hits'", async () => {
    mockEmbedAndSearch({ hits: [] });
    const r = await retrieveForChat('something nobody ever emailed about');
    expect(r.reason).toBe('no_hits');
    expect(r.refs).toEqual([]);
  });

  it("all hits below the default floor → empty + 'below_floor' (distinct from no_hits)", async () => {
    mockEmbedAndSearch({
      hits: [hit('low-1', 0.64), hit('low-2', 0.5)],
    });
    const r = await retrieveForChat('borderline relevance query');
    expect(r.reason).toBe('below_floor');
    expect(r.refs).toEqual([]);
  });

  it('mixed corpus → drops sub-floor hits, keeps survivors', async () => {
    mockEmbedAndSearch({
      hits: [hit('keep', 0.82), hit('drop', 0.4), hit('keep2', 0.66)],
    });
    const r = await retrieveForChat('mixed relevance query');
    expect(r.reason).toBe('ok');
    expect(r.refs.map((x) => x.point_id)).toEqual(['keep', 'keep2']);
  });

  it('boundary: hit at exactly the floor survives (inclusive >=)', async () => {
    process.env.CHAT_RETRIEVE_SCORE_FLOOR = '0.70';
    mockEmbedAndSearch({ hits: [hit('boundary', 0.7)] });
    const r = await retrieveForChat('at-floor query');
    expect(r.reason).toBe('ok');
    expect(r.refs.map((x) => x.point_id)).toEqual(['boundary']);
  });

  it('honors CHAT_RETRIEVE_SCORE_FLOOR override (lowered floor keeps more)', async () => {
    process.env.CHAT_RETRIEVE_SCORE_FLOOR = '0.50';
    mockEmbedAndSearch({ hits: [hit('mid', 0.6)] });
    const r = await retrieveForChat('lowered floor query');
    // At default 0.65 this would be below_floor; at 0.50 it survives.
    expect(r.reason).toBe('ok');
    expect(r.refs.map((x) => x.point_id)).toEqual(['mid']);
  });

  it('falls back to default floor when CHAT_RETRIEVE_SCORE_FLOOR is malformed', async () => {
    process.env.CHAT_RETRIEVE_SCORE_FLOOR = 'not-a-number';
    mockEmbedAndSearch({ hits: [hit('low', 0.6)] });
    const r = await retrieveForChat('typo floor query');
    // Fallback 0.65 drops the 0.60 hit.
    expect(r.reason).toBe('below_floor');
  });

  it('honors CHAT_RETRIEVE_TOP_K override on the Qdrant limit', async () => {
    process.env.CHAT_RETRIEVE_TOP_K = '8';
    const captured: { value: unknown } = { value: null };
    mockEmbedAndSearch({ hits: [], capturedSearchBody: captured });
    await retrieveForChat('wider source set query');
    expect((captured.value as { limit?: number } | null)?.limit).toBe(8);
  });

  it('caps excerpts at RAG_RETRIEVE_EXCERPT_CHARS', async () => {
    process.env.RAG_RETRIEVE_EXCERPT_CHARS = '10';
    mockEmbedAndSearch({
      hits: [hit('a', 0.9, { body_excerpt: 'x'.repeat(100) })],
    });
    const r = await retrieveForChat('long body query');
    expect(r.refs[0].excerpt).toHaveLength(10);
  });

  it("embed outage → success-shaped empty + 'embed_unavailable' (no throw)", async () => {
    mockEmbedAndSearch({ embedFails: true });
    const r = await retrieveForChat('embed is down');
    expect(r.reason).toBe('embed_unavailable');
    expect(r.refs).toEqual([]);
  });

  it("qdrant outage → success-shaped empty + 'qdrant_unavailable' (no throw)", async () => {
    mockEmbedAndSearch({ searchFails: true });
    const r = await retrieveForChat('qdrant is down');
    expect(r.reason).toBe('qdrant_unavailable');
    expect(r.refs).toEqual([]);
  });
});
