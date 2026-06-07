import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// STAQPRO-199 — embedText() must:
//   1. Char-truncate oversized inputs before the wire so nomic-embed-text
//      stops returning Ollama 500 "the input length exceeds the context
//      length" on long emails / thread excerpts.
//   2. Forward `options.num_ctx` (default 8192) so Ollama uses the full
//      nomic window rather than its embedding-default (often 512).
//   3. Never throw to the caller — RAG is augmentation, not gate. On any
//      infrastructure failure, return null.
//
// Pre-fix behavior: a long input would 500 at the model layer and
// embedText would return null AFTER hitting Ollama (one wasted RTT plus
// a noisy 500 in logs). Post-fix: the wire payload itself is bounded so
// the server-side error never fires.

const OLLAMA_URL = 'http://test-ollama:11434/api/embeddings';

function setEnv() {
  process.env.OLLAMA_BASE_URL = 'http://test-ollama:11434';
  process.env.EMBED_MODEL = 'nomic-embed-text:v1.5';
  // Pin the test config so changes to defaults don't silently flip
  // assertion meanings. STAQPRO-200 — pinned to 4500 to match the
  // tightened in-code default (was 6000 prior).
  process.env.EMBED_NUM_CTX = '8192';
  process.env.EMBED_MAX_CHARS = '4500';
}

interface CapturedRequest {
  url: string;
  body: {
    model?: string;
    prompt?: string;
    options?: { num_ctx?: number };
  };
}

function captureFetch(responseEmbedding: number[]): {
  fetchMock: typeof fetch;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    captured.push({ url, body });
    return new Response(JSON.stringify({ embedding: responseEmbedding }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchMock, captured };
}

describe('embedText — STAQPRO-199 truncation + num_ctx', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    setEnv();
    // Reset module cache so the embed.ts module re-reads the env we just set.
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('forwards options.num_ctx=8192 on the wire', async () => {
    const embedding = new Array(768).fill(0.01);
    const { fetchMock, captured } = captureFetch(embedding);
    globalThis.fetch = fetchMock;

    const { embedText } = await import('@/lib/rag/embed');
    const out = await embedText('hello world');

    expect(out).not.toBeNull();
    expect(out?.length).toBe(768);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(OLLAMA_URL);
    expect(captured[0]?.body.options?.num_ctx).toBe(8192);
    expect(captured[0]?.body.model).toBe('nomic-embed-text:v1.5');
  });

  it('truncates inputs longer than EMBED_MAX_CHARS before sending', async () => {
    const embedding = new Array(768).fill(0.01);
    const { fetchMock, captured } = captureFetch(embedding);
    globalThis.fetch = fetchMock;

    // 50,000 chars — comfortably over the 4500 cap and the kind of size
    // that triggers nomic 500s in production (long Gmail threads).
    const longInput = 'a'.repeat(50_000);
    const { embedText } = await import('@/lib/rag/embed');

    // Silence the truncation warn so test output stays clean while still
    // asserting it fired.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await embedText(longInput);

    expect(out).not.toBeNull();
    expect(captured[0]?.body.prompt?.length).toBe(4500);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/truncated/i);
  });

  it('passes short inputs through unchanged (no truncation, no warn)', async () => {
    const embedding = new Array(768).fill(0.01);
    const { fetchMock, captured } = captureFetch(embedding);
    globalThis.fetch = fetchMock;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { embedText } = await import('@/lib/rag/embed');
    const out = await embedText('a short message');

    expect(out).not.toBeNull();
    expect(captured[0]?.body.prompt).toBe('a short message');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not throw on oversized input (returns null on 500, never bubbles)', async () => {
    // Even with truncation we still want defense-in-depth: if Ollama
    // ever returns 500 anyway (model swap, version regression), the
    // pipeline must NOT fail. RAG is augmentation, not gate.
    globalThis.fetch = vi.fn(
      async () =>
        new Response('{"error":"the input length exceeds the context length"}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { embedText } = await import('@/lib/rag/embed');
    const out = await embedText('a'.repeat(20_000));

    expect(out).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null on empty / whitespace-only input without calling Ollama', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const { embedText } = await import('@/lib/rag/embed');
    expect(await embedText('')).toBeNull();
    expect(await embedText('   \n  ')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
