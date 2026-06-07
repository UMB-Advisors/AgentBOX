import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isCloudRetrievalEnabled, retrieveForDraft } from '@/lib/rag/retrieve';

// STAQPRO-191 — retrieveForDraft contract:
//
//   - Local route → always attempts retrieval
//   - Cloud route + RAG_CLOUD_ROUTE_ENABLED unset → cloud_gated (privacy default)
//   - Cloud route + RAG_CLOUD_ROUTE_ENABLED=1 → attempts retrieval
//   - Embed unavailable → embed_unavailable, no refs
//   - Qdrant unreachable → qdrant_unavailable, no refs
//   - Empty hits → no_hits, no refs
//   - Happy path → ok, refs[] populated with point_id + scored excerpts
//
// All branches MUST return cleanly (never throw) so the draft-prompt route
// can decide drafting falls back to persona-stub.

const baseInput = {
  from_addr: 'cust@example.com',
  subject: 'Re: order',
  // STAQPRO-221 (H4) — kept >= 40 chars so the thin-inbound gate doesn't
  // pre-empt these STAQPRO-191 retrieval contract assertions.
  body_text: 'Confirming the order details for the Q3 shipment we discussed.',
  // STAQPRO-191 — single-persona appliances seed 'default'. The retrieval
  // call always carries a persona_key now (multi-persona future-proofing).
  persona_key: 'default',
};

function mockEmbedAndSearch(opts: {
  embedding?: number[] | null;
  hits?: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
  searchStatus?: number;
  // STAQPRO-148 — KB collection mock. Defaults to empty hits so existing
  // tests behave as if KB has no relevant content (kb_reason='no_hits').
  kbHits?: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
  kbSearchStatus?: number;
}) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/embeddings')) {
      if (opts.embedding === null) return new Response('boom', { status: 500 });
      const e = opts.embedding ?? new Array(768).fill(0.01);
      return new Response(JSON.stringify({ embedding: e }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/collections/email_messages/points/search')) {
      const status = opts.searchStatus ?? 200;
      if (status !== 200) return new Response('boom', { status });
      return new Response(JSON.stringify({ result: opts.hits ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/collections/kb_documents/points/search')) {
      const status = opts.kbSearchStatus ?? 200;
      if (status !== 200) return new Response('boom', { status });
      return new Response(JSON.stringify({ result: opts.kbHits ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('retrieveForDraft — STAQPRO-191', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.RAG_CLOUD_ROUTE_ENABLED;
  const originalDisabledEnv = process.env.RAG_DISABLED;

  beforeEach(() => {
    process.env.OLLAMA_BASE_URL = 'http://test-ollama:11434';
    process.env.QDRANT_URL = 'http://test-qdrant:6333';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.RAG_CLOUD_ROUTE_ENABLED;
    else process.env.RAG_CLOUD_ROUTE_ENABLED = originalEnv;
    if (originalDisabledEnv === undefined) delete process.env.RAG_DISABLED;
    else process.env.RAG_DISABLED = originalDisabledEnv;
    vi.restoreAllMocks();
  });

  it('returns disabled with empty refs when RAG_DISABLED=1, without firing fetch (STAQPRO-198)', async () => {
    process.env.RAG_DISABLED = '1';
    // The short-circuit must precede the embed/Qdrant pair — assert by
    // installing a guard fetch that throws if it fires.
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        new Error('fetch should NOT have been called when RAG_DISABLED=1'),
      ) as unknown as typeof fetch;

    // Both routes must short-circuit, even cloud (which would otherwise hit
    // the cloud_gated branch first).
    const local = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(local.reason).toBe('disabled');
    expect(local.refs).toEqual([]);

    const cloud = await retrieveForDraft({ ...baseInput, draft_source: 'cloud' });
    expect(cloud.reason).toBe('disabled');
    expect(cloud.refs).toEqual([]);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns cloud_gated when draft_source=cloud and env not set', async () => {
    delete process.env.RAG_CLOUD_ROUTE_ENABLED;
    // No fetch should fire — assert by NOT mocking and using a guard.
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('fetch should NOT have been called')) as unknown as typeof fetch;

    const r = await retrieveForDraft({ ...baseInput, draft_source: 'cloud' });
    expect(r.reason).toBe('cloud_gated');
    expect(r.refs).toEqual([]);
    // STAQPRO-148 — KB mirrors the cloud-gate but with a distinct reason
    // value so audit logs can disambiguate even though the gate is shared.
    expect(r.kb_reason).toBe('kb_cloud_gated');
    expect(r.kb_refs).toEqual([]);
  });

  it('returns embed_unavailable when Ollama embed call fails', async () => {
    mockEmbedAndSearch({ embedding: null });
    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('embed_unavailable');
    expect(r.refs).toEqual([]);
  });

  it('returns qdrant_unavailable on Qdrant 5xx', async () => {
    mockEmbedAndSearch({ searchStatus: 500 });
    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('qdrant_unavailable');
    expect(r.refs).toEqual([]);
  });

  it('returns no_hits with empty refs on 0 results', async () => {
    mockEmbedAndSearch({ hits: [] });
    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('no_hits');
    expect(r.refs).toEqual([]);
  });

  it('returns ok with formatted refs on happy path', async () => {
    mockEmbedAndSearch({
      hits: [
        {
          id: 'pid-1',
          score: 0.92,
          payload: {
            message_id: 'm1',
            sender: 'cust@example.com',
            subject: 'Last week order',
            body_excerpt: 'We confirmed the 1000-unit order on March 12.',
            sent_at: '2026-04-15T10:00:00Z',
            direction: 'outbound',
          },
        },
        {
          id: 'pid-2',
          score: 0.81,
          payload: {
            message_id: 'm2',
            sender: 'cust@example.com',
            subject: null,
            body_excerpt: 'Their inbound asking about lead time.',
            sent_at: '2026-04-10T09:00:00Z',
            direction: 'inbound',
          },
        },
      ],
    });

    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('ok');
    expect(r.refs).toHaveLength(2);
    expect(r.refs[0].point_id).toBe('pid-1');
    expect(r.refs[0].source).toContain('we wrote');
    expect(r.refs[0].source).toContain('2026-04-15');
    expect(r.refs[0].excerpt).toContain('1000-unit');
    expect(r.refs[1].source).toContain('they wrote');
    expect(r.refs[1].source).toContain('(no subject)');
  });

  it('attempts retrieval on cloud route when RAG_CLOUD_ROUTE_ENABLED=1', async () => {
    process.env.RAG_CLOUD_ROUTE_ENABLED = '1';
    mockEmbedAndSearch({ hits: [] });
    const r = await retrieveForDraft({ ...baseInput, draft_source: 'cloud' });
    // Reaches Qdrant (no_hits), not cloud_gated.
    expect(r.reason).toBe('no_hits');
  });

  it('returns no_hits when from_addr is empty (no counterparty filter possible)', async () => {
    mockEmbedAndSearch({ hits: [{ id: 'x', score: 1, payload: {} as never }] });
    const r = await retrieveForDraft({
      from_addr: '',
      subject: 'Hi',
      body_text: 'Hello',
      draft_source: 'local',
      persona_key: 'default',
    });
    expect(r.reason).toBe('no_hits');
    expect(r.refs).toEqual([]);
    // STAQPRO-148 — empty sender short-circuits BOTH retrievals (no embed
    // budget burned for a malformed inbound). KB reason is 'none' (not
    // attempted) rather than 'no_hits' (searched, found nothing) — the
    // distinction matters for future KB hit-rate eval (Linus pre-flight).
    expect(r.kb_reason).toBe('none');
    expect(r.kb_refs).toEqual([]);
  });

  // STAQPRO-148 — KB-specific test cases.

  it('returns kb_refs with formatted KB hits when KB collection has matches', async () => {
    mockEmbedAndSearch({
      hits: [],
      kbHits: [
        {
          id: 'kb-pid-1',
          score: 0.78,
          payload: {
            doc_id: 42,
            chunk_index: 0,
            doc_title: 'Returns Policy',
            doc_sha256: 'abc123',
            mime_type: 'text/markdown',
            excerpt: 'Heron Labs accepts returns within 30 days of delivery.',
            uploaded_at: '2026-05-02T00:00:00Z',
          },
        },
      ],
    });
    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('no_hits'); // email collection empty in this scenario
    expect(r.kb_reason).toBe('ok');
    expect(r.kb_refs).toHaveLength(1);
    expect(r.kb_refs[0].point_id).toBe('kb-pid-1');
    expect(r.kb_refs[0].source).toBe('Returns Policy');
    expect(r.kb_refs[0].excerpt).toContain('30 days');
    expect(r.kb_refs[0].doc_id).toBe(42);
    expect(r.kb_refs[0].chunk_index).toBe(0);
  });

  it('returns kb_reason=qdrant_unavailable on KB collection 5xx (independent of email path)', async () => {
    mockEmbedAndSearch({
      hits: [
        {
          id: 'pid-1',
          score: 0.9,
          payload: {
            message_id: 'm1',
            sender: 'cust@example.com',
            subject: 'Order',
            body_excerpt: 'Order body',
            sent_at: '2026-04-15T10:00:00Z',
            direction: 'outbound',
          },
        },
      ],
      kbSearchStatus: 500,
    });
    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    // Email retrieval succeeded
    expect(r.reason).toBe('ok');
    expect(r.refs).toHaveLength(1);
    // KB retrieval failed independently — partial degradation is supported.
    expect(r.kb_reason).toBe('qdrant_unavailable');
    expect(r.kb_refs).toEqual([]);
  });

  it('happy path returns BOTH email refs AND kb refs in parallel', async () => {
    mockEmbedAndSearch({
      hits: [
        {
          id: 'pid-1',
          score: 0.92,
          payload: {
            message_id: 'm1',
            sender: 'cust@example.com',
            subject: 'Order',
            body_excerpt: 'Order body',
            sent_at: '2026-04-15T10:00:00Z',
            direction: 'outbound',
          },
        },
      ],
      kbHits: [
        {
          id: 'kb-pid-1',
          score: 0.81,
          payload: {
            doc_id: 7,
            chunk_index: 2,
            doc_title: 'MOQ Reference',
            doc_sha256: 'def456',
            mime_type: 'text/markdown',
            excerpt: 'Wholesale MOQ is 144 units.',
            uploaded_at: '2026-05-02T00:00:00Z',
          },
        },
      ],
    });
    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('ok');
    expect(r.refs).toHaveLength(1);
    expect(r.kb_reason).toBe('ok');
    expect(r.kb_refs).toHaveLength(1);
    expect(r.kb_refs[0].source).toBe('MOQ Reference');
  });
});

describe('isCloudRetrievalEnabled — STAQPRO-191', () => {
  it('reflects RAG_CLOUD_ROUTE_ENABLED env at module load', () => {
    // The const captures env at import time so the runtime value is what
    // matters — this is a smoke check that the helper exists and returns
    // a boolean. Branch coverage lives in the cloud_gated test above.
    expect(typeof isCloudRetrievalEnabled()).toBe('boolean');
  });
});
