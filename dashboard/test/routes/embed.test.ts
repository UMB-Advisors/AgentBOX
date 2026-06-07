import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// STAQPRO-190 — POST /api/internal/embed contract. Mocks Ollama + Qdrant
// over global fetch so the route's failure-handling guarantees can be
// asserted without a live appliance:
//   - 200 + ok:true on happy path
//   - 200 + ok:false reason='embed_unavailable' on Ollama failure
//   - 200 + ok:false reason='qdrant_upsert_failed:...' on Qdrant failure
//   - 400 on bad input (caller bug, not infra failure)
//   - 400 on unknown account (MBOX-348 fan-out misconfig, not infra failure)

// MBOX-348 — the route now resolves the owning account via the DB. Mock it so
// this contract test stays DB-free (default path → account 1); individual tests
// override for the unknown-account branch.
vi.mock('@/lib/queries-accounts', () => ({
  resolveIngestAccountId: vi.fn(async () => ({ ok: true, account_id: 1 })),
}));

const validBody = {
  message_id: 'test-msg-1',
  thread_id: 'thread-1',
  sender: 'sender@example.com',
  recipient: 'op@example.com',
  subject: 'Re: order',
  body: 'Confirming the details.',
  sent_at: '2026-05-01T12:00:00Z',
  direction: 'inbound' as const,
  classification_category: 'reorder',
};

function fakeReq(body: unknown): Request {
  return new Request('http://test.local/api/internal/embed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/internal/embed — STAQPRO-190', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.OLLAMA_BASE_URL = 'http://test-ollama:11434';
    process.env.QDRANT_URL = 'http://test-qdrant:6333';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns 200 ok:true on happy path', async () => {
    const embedding = new Array(768).fill(0.01);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/embeddings')) {
        return new Response(JSON.stringify({ embedding }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/collections/email_messages/points')) {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const { POST } = await import('@/app/api/internal/embed/route');
    const res = await POST(fakeReq(validBody) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.message_id).toBe(validBody.message_id);
    expect(json.point_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns 200 ok:false embed_unavailable when Ollama fails', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/embeddings')) {
        return new Response('boom', { status: 500 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const { POST } = await import('@/app/api/internal/embed/route');
    const res = await POST(fakeReq(validBody) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.reason).toBe('embed_unavailable');
  });

  it('returns 200 ok:false qdrant_upsert_failed when Qdrant fails', async () => {
    const embedding = new Array(768).fill(0.01);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/embeddings')) {
        return new Response(JSON.stringify({ embedding }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/collections/email_messages/points')) {
        return new Response(JSON.stringify({ status: { error: 'boom' } }), { status: 500 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const { POST } = await import('@/app/api/internal/embed/route');
    const res = await POST(fakeReq(validBody) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.reason).toMatch(/^qdrant_upsert_failed/);
  });

  it('returns 400 on missing message_id (caller bug, not infra failure)', async () => {
    const { message_id: _drop, ...rest } = validBody;
    const { POST } = await import('@/app/api/internal/embed/route');
    const res = await POST(fakeReq(rest) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('validation_failed');
  });

  it('returns 400 when the fan-out names an unknown account (MBOX-348)', async () => {
    const { resolveIngestAccountId } = await import('@/lib/queries-accounts');
    vi.mocked(resolveIngestAccountId).mockResolvedValueOnce({
      ok: false,
      reason: 'unknown account_email ghost@nope.com',
    });
    const { POST } = await import('@/app/api/internal/embed/route');
    const res = await POST(fakeReq({ ...validBody, account_email: 'ghost@nope.com' }) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.reason).toMatch(/unknown account_email/);
  });
});
