import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQdrantCollectionHealth } from '@/lib/queries-system';

// STAQPRO-188 — getQdrantCollectionHealth contract.
//
// The real Qdrant server is not running in unit-test context; we mock global
// fetch. The contract under test:
//   - 200 + body  → { exists: true, points_count, vectors_count }
//   - 404         → { exists: false, points_count: null, vectors_count: null }
//   - other 5xx   → null  (treated as "Qdrant unreachable / degraded")
//   - throw       → null

describe('getQdrantCollectionHealth — STAQPRO-188', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.QDRANT_URL = 'http://qdrant-test:6333';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns exists:true with point counts on 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: { points_count: 42, vectors_count: 42 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const r = await getQdrantCollectionHealth('email_messages');
    expect(r).toEqual({ exists: true, points_count: 42, vectors_count: 42 });
  });

  it('returns exists:false on 404 (collection missing — bootstrap not run)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('not found', { status: 404 })) as unknown as typeof fetch;

    const r = await getQdrantCollectionHealth('email_messages');
    expect(r).toEqual({ exists: false, points_count: null, vectors_count: null });
  });

  it('returns null on 500 (Qdrant degraded)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('boom', { status: 500 })) as unknown as typeof fetch;

    const r = await getQdrantCollectionHealth('email_messages');
    expect(r).toBeNull();
  });

  it('returns null on fetch throw (Qdrant unreachable)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const r = await getQdrantCollectionHealth('email_messages');
    expect(r).toBeNull();
  });

  it('handles missing payload fields gracefully (null counts, exists true)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const r = await getQdrantCollectionHealth('email_messages');
    expect(r).toEqual({ exists: true, points_count: null, vectors_count: null });
  });
});
