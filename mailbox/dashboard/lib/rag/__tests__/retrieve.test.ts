// dashboard/lib/rag/__tests__/retrieve.test.ts
//
// STAQPRO-219 — assert the inbound's own backfilled twin never appears in
// `refs[].point_id`. Phase-B inspection of STAQPRO-207's 10 outliers showed
// every packet had its top retrieved ref at unit cosine — the inbound's own
// embedding scoring 1.000 against itself. retrieveForDraft must compute the
// inbound's deterministic point UUID and drop it via Qdrant must_not.has_id.
//
// The companion ./test/lib/rag-retrieve.test.ts holds the broader contract
// surface (cloud_gated, embed_unavailable, qdrant_unavailable, KB parallel
// search). This file is narrowly scoped to the self-filter behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pointIdFromMessageId } from '../qdrant';
import { retrieveForDraft } from '../retrieve';

const INBOUND_MESSAGE_ID = '19c813bde357dc32'; // one of the STAQPRO-207 outliers
const SELF_POINT_ID = pointIdFromMessageId(INBOUND_MESSAGE_ID);

// Body kept >= 40 chars so the STAQPRO-221 (H4) thin-inbound gate doesn't
// pre-empt these STAQPRO-219 self-filter assertions. Both pieces test
// orthogonal contracts.
const baseInput = {
  from_addr: 'cust@example.com',
  subject: 'Re: order',
  body_text: 'Confirming the order details for the Q3 shipment we discussed.',
  persona_key: 'default',
  message_id: INBOUND_MESSAGE_ID,
};

interface MockOpts {
  // Hits the mock will return for the email collection. The mock also
  // enforces the Qdrant `must_not.has_id` filter the call should be sending,
  // mirroring real Qdrant behavior.
  hits?: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
  // Captures the parsed search request body so the test can inspect the
  // filter shape Qdrant would have received.
  capturedSearchBody?: { value: unknown };
}

function mockEmbedAndSearch(opts: MockOpts) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/embeddings')) {
      return new Response(JSON.stringify({ embedding: new Array(768).fill(0.01) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/collections/email_messages/points/search')) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (opts.capturedSearchBody) opts.capturedSearchBody.value = body;
      // Mirror Qdrant: enforce must_not.has_id on the way out so the
      // assertion isn't just "did we send the filter" but also "would the
      // filter actually drop the self-match if Qdrant returned it."
      const filter = body?.filter;
      const excludedIds = new Set<string>();
      const must_not = filter?.must_not as Array<{ has_id?: string[] }> | undefined;
      if (Array.isArray(must_not)) {
        for (const clause of must_not) {
          if (Array.isArray(clause.has_id)) {
            for (const id of clause.has_id) excludedIds.add(id);
          }
        }
      }
      const filteredHits = (opts.hits ?? []).filter((h) => !excludedIds.has(h.id));
      return new Response(JSON.stringify({ result: filteredHits }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/collections/kb_documents/points/search')) {
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('retrieveForDraft self-filter — STAQPRO-219', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.OLLAMA_BASE_URL = 'http://test-ollama:11434';
    process.env.QDRANT_URL = 'http://test-qdrant:6333';
    delete process.env.RAG_DISABLED;
    delete process.env.RAG_CLOUD_ROUTE_ENABLED;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends must_not.has_id with the inbound self point UUID to Qdrant', async () => {
    const captured: { value: unknown } = { value: null };
    mockEmbedAndSearch({ hits: [], capturedSearchBody: captured });

    await retrieveForDraft({ ...baseInput, draft_source: 'local' });

    expect(captured.value).toMatchObject({
      filter: {
        must_not: [{ has_id: [SELF_POINT_ID] }],
      },
    });
  });

  it("inbound's own UUID never appears in refs[].point_id even if Qdrant returns it", async () => {
    // Simulate a misbehaving Qdrant that ignored the filter — the must_not
    // clause is enforced both at the wire and (defensively) here. The test
    // asserts the contract: under no circumstance does the self UUID land
    // in refs[].
    mockEmbedAndSearch({
      hits: [
        // The self-match Qdrant would have returned at 1.000 pre-fix.
        {
          id: SELF_POINT_ID,
          score: 1.0,
          payload: {
            message_id: INBOUND_MESSAGE_ID,
            sender: 'cust@example.com',
            subject: 'Re: order',
            body_excerpt: 'Confirming the order details.',
            sent_at: '2026-04-15T10:00:00Z',
            direction: 'inbound',
          },
        },
        // A genuine prior message from the same counterparty.
        {
          id: 'pid-prior',
          score: 0.78,
          payload: {
            message_id: 'prior-msg',
            sender: 'cust@example.com',
            subject: 'Earlier thread',
            body_excerpt: 'We had agreed on net-30 terms.',
            sent_at: '2026-04-01T09:00:00Z',
            direction: 'inbound',
          },
        },
      ],
    });

    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('ok');
    for (const ref of r.refs) {
      expect(ref.point_id).not.toBe(SELF_POINT_ID);
    }
    // Sanity: the genuine prior survives the filter.
    expect(r.refs.map((x) => x.point_id)).toContain('pid-prior');
  });

  it('refs=0 with reason no_hits when the only Qdrant hit was the self-match', async () => {
    // Spot-check mirrors the issue's acceptance criterion: previously-
    // inspected packets that used to return refs=1 (the self-match) should
    // now collapse to empty refs + no_hits, falling through to persona-stub.
    mockEmbedAndSearch({
      hits: [
        {
          id: SELF_POINT_ID,
          score: 1.0,
          payload: {
            message_id: INBOUND_MESSAGE_ID,
            sender: 'cust@example.com',
            subject: 'Re: order',
            body_excerpt: 'Confirming the order details.',
            sent_at: '2026-04-15T10:00:00Z',
            direction: 'inbound',
          },
        },
      ],
    });

    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('no_hits');
    expect(r.refs).toEqual([]);
  });

  it('omits must_not.has_id when message_id is not supplied (back-compat)', async () => {
    // Eval harness and legacy callers without a message_id should retain
    // pre-219 behavior — the filter clause is conditional, not always-on.
    const captured: { value: unknown } = { value: null };
    mockEmbedAndSearch({ hits: [], capturedSearchBody: captured });

    const inputWithoutMessageId = {
      from_addr: 'cust@example.com',
      subject: 'Re: order',
      body_text: 'Confirming the order details for the Q3 shipment we discussed.',
      persona_key: 'default',
      draft_source: 'local' as const,
    };
    await retrieveForDraft(inputWithoutMessageId);

    const body = captured.value as { filter?: { must_not?: unknown } } | null;
    expect(body?.filter?.must_not).toBeUndefined();
  });
});

// =============================================================================
// STAQPRO-221 — H2 (outbound voice priming) + H4 (thin-inbound gate)
// =============================================================================

// Per-request capture: every email_messages/points/search call gets recorded
// so multi-search tests (H2 outbound + inbound) can assert filter shapes on
// each call independently.
function mockMultiSearch(opts: {
  hitsBySearch: Array<{
    filterFingerprint: (filter: unknown) => boolean;
    hits: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
  }>;
  capturedBodies?: Array<unknown>;
}) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/embeddings')) {
      return new Response(JSON.stringify({ embedding: new Array(768).fill(0.01) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/collections/email_messages/points/search')) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (opts.capturedBodies) opts.capturedBodies.push(body);
      const matched = opts.hitsBySearch.find((s) => s.filterFingerprint(body?.filter));
      const hits = matched?.hits ?? [];
      return new Response(JSON.stringify({ result: hits }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/collections/kb_documents/points/search')) {
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

// Helpers — read the must filter clauses regardless of order.
function hasMustField(filter: unknown, key: string, value: string): boolean {
  const f = filter as { must?: Array<{ key?: string; match?: { value?: string } }> } | null;
  if (!Array.isArray(f?.must)) return false;
  return f.must.some((m) => m.key === key && m.match?.value === value);
}
function hasNoMustField(filter: unknown, key: string): boolean {
  const f = filter as { must?: Array<{ key?: string }> } | null;
  if (!Array.isArray(f?.must)) return true;
  return !f.must.some((m) => m.key === key);
}

const baseInputForH2 = {
  from_addr: 'cust@example.com',
  subject: 'Re: order',
  body_text: 'Confirming the order details for the Q3 shipment we discussed.',
  persona_key: 'default',
  message_id: INBOUND_MESSAGE_ID,
};

describe('retrieveForDraft H2 — outbound voice priming (STAQPRO-221)', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.OLLAMA_BASE_URL = 'http://test-ollama:11434';
    process.env.QDRANT_URL = 'http://test-qdrant:6333';
    delete process.env.RAG_DISABLED;
    delete process.env.RAG_CLOUD_ROUTE_ENABLED;
    delete process.env.RAG_RETRIEVE_TOP_K_OUTBOUND;
    delete process.env.RAG_RETRIEVE_TOP_K_INBOUND;
    delete process.env.RAG_RETRIEVE_TOP_K;
    delete process.env.RAG_MIN_INBOUND_CHARS;
    // STAQPRO-222 (H5) — pin floor to 0 so H2 fixture scores (some below
    // the new 0.70 default) aren't dropped by the score floor. H5 has its
    // own dedicated describe block below; this block stays a pure H2 test.
    process.env.RAG_MIN_SCORE = '0';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.MAILBOX_OPERATOR_EMAIL;
    delete process.env.RAG_MIN_SCORE;
  });

  it('runs two Qdrant searches (inbound + outbound) when MAILBOX_OPERATOR_EMAIL set', async () => {
    process.env.MAILBOX_OPERATOR_EMAIL = 'op@heronlabsinc.com';
    const captured: unknown[] = [];
    mockMultiSearch({
      hitsBySearch: [
        // Inbound arm — filters on sender == counterparty.
        {
          filterFingerprint: (f) => hasMustField(f, 'sender', 'cust@example.com'),
          hits: [
            {
              id: 'pid-inbound-1',
              score: 0.7,
              payload: {
                message_id: 'm-inbound-1',
                sender: 'cust@example.com',
                recipient: 'op@heronlabsinc.com',
                subject: 'They asked about Q2',
                body_excerpt: 'Q2 shipment timing question',
                sent_at: '2026-03-01T10:00:00Z',
                direction: 'inbound',
              },
            },
          ],
        },
        // Outbound arm — filters on sender == operator AND recipient == counterparty.
        {
          filterFingerprint: (f) =>
            hasMustField(f, 'sender', 'op@heronlabsinc.com') &&
            hasMustField(f, 'recipient', 'cust@example.com'),
          hits: [
            {
              id: 'pid-outbound-1',
              score: 0.65,
              payload: {
                message_id: 'm-outbound-1',
                sender: 'op@heronlabsinc.com',
                recipient: 'cust@example.com',
                subject: 'Our reply',
                body_excerpt: 'Confirmed your Q2 timing — we ship Friday.',
                sent_at: '2026-03-01T11:00:00Z',
                direction: 'outbound',
              },
            },
          ],
        },
      ],
      capturedBodies: captured,
    });

    const r = await retrieveForDraft({ ...baseInputForH2, draft_source: 'local' });

    expect(r.reason).toBe('ok');
    // Both arms' refs should show up; outbound is the H2 win.
    const ids = r.refs.map((x) => x.point_id);
    expect(ids).toContain('pid-inbound-1');
    expect(ids).toContain('pid-outbound-1');
    // The outbound search MUST have been issued — flunked test means the
    // MAILBOX_OPERATOR_EMAIL→outbound wiring regressed.
    expect(captured.length).toBe(2);
  });

  it('honors RAG_RETRIEVE_TOP_K as the merged sanity ceiling', async () => {
    process.env.MAILBOX_OPERATOR_EMAIL = 'op@heronlabsinc.com';
    process.env.RAG_RETRIEVE_TOP_K = '2';
    process.env.RAG_RETRIEVE_TOP_K_INBOUND = '3';
    process.env.RAG_RETRIEVE_TOP_K_OUTBOUND = '3';
    mockMultiSearch({
      hitsBySearch: [
        {
          filterFingerprint: (f) => hasMustField(f, 'sender', 'cust@example.com'),
          hits: Array.from({ length: 3 }, (_, i) => ({
            id: `pid-in-${i}`,
            score: 0.5 + i * 0.05,
            payload: {
              message_id: `m-in-${i}`,
              sender: 'cust@example.com',
              recipient: 'op@heronlabsinc.com',
              subject: 's',
              body_excerpt: 'x',
              sent_at: '2026-03-01T10:00:00Z',
              direction: 'inbound',
            },
          })),
        },
        {
          filterFingerprint: (f) => hasMustField(f, 'recipient', 'cust@example.com'),
          hits: Array.from({ length: 3 }, (_, i) => ({
            id: `pid-out-${i}`,
            score: 0.9 - i * 0.05,
            payload: {
              message_id: `m-out-${i}`,
              sender: 'op@heronlabsinc.com',
              recipient: 'cust@example.com',
              subject: 's',
              body_excerpt: 'x',
              sent_at: '2026-03-01T10:00:00Z',
              direction: 'outbound',
            },
          })),
        },
      ],
    });

    const r = await retrieveForDraft({ ...baseInputForH2, draft_source: 'local' });
    expect(r.reason).toBe('ok');
    // 6 candidates, capped at 2 by RAG_RETRIEVE_TOP_K. Top-scoring outbound
    // wins (0.90 > 0.85 inbound), second slot goes to next-best (0.85
    // outbound), not the next inbound (0.60).
    expect(r.refs.length).toBe(2);
    expect(r.refs.every((x) => x.score >= 0.5)).toBe(true);
    // Highest score first.
    expect(r.refs[0].score).toBeGreaterThan(r.refs[1].score);
  });

  it('falls back to inbound-only when MAILBOX_OPERATOR_EMAIL is unset', async () => {
    delete process.env.MAILBOX_OPERATOR_EMAIL;
    const captured: unknown[] = [];
    mockMultiSearch({
      hitsBySearch: [
        {
          filterFingerprint: (f) => hasMustField(f, 'sender', 'cust@example.com'),
          hits: [
            {
              id: 'pid-inbound-1',
              score: 0.7,
              payload: {
                message_id: 'm-inbound-1',
                sender: 'cust@example.com',
                recipient: 'op@heronlabsinc.com',
                subject: 'Inbound only',
                body_excerpt: 'x',
                sent_at: '2026-03-01T10:00:00Z',
                direction: 'inbound',
              },
            },
          ],
        },
      ],
      capturedBodies: captured,
    });

    // Suppress the warn nag in test output.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await retrieveForDraft({ ...baseInputForH2, draft_source: 'local' });

    expect(r.reason).toBe('ok');
    expect(r.refs.map((x) => x.point_id)).toEqual(['pid-inbound-1']);
    // Only ONE Qdrant search — the inbound arm.
    expect(captured.length).toBe(1);
    // The single search must NOT have a recipient filter (that's the
    // outbound arm's territory).
    expect(hasNoMustField(captured[0], 'recipient')).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('retrieveForDraft H4 — thin-inbound gate (STAQPRO-221)', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.OLLAMA_BASE_URL = 'http://test-ollama:11434';
    process.env.QDRANT_URL = 'http://test-qdrant:6333';
    delete process.env.RAG_DISABLED;
    delete process.env.RAG_CLOUD_ROUTE_ENABLED;
    delete process.env.RAG_MIN_INBOUND_CHARS;
    delete process.env.MAILBOX_OPERATOR_EMAIL;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns reason='inbound_too_thin' when stripped body is under the floor", async () => {
    // Phase-B outlier 19b0ed17519285b1 shape — fresh reply 'ok' over quote chain.
    const thinBody = `ok

On Mon, Apr 28, 2026 at 9:00 AM Sender <s@x.com> wrote:
> Long thread...`;
    // No fetch should fire — gate short-circuits before embed.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('should not be called — thin-inbound gate must short-circuit');
    }) as unknown as typeof fetch;

    const r = await retrieveForDraft({
      from_addr: 'cust@example.com',
      subject: 'Re: order',
      body_text: thinBody,
      persona_key: 'default',
      message_id: 'm1',
      draft_source: 'local',
    });

    expect(r.reason).toBe('inbound_too_thin');
    expect(r.refs).toEqual([]);
  });

  it("returns reason='inbound_too_thin' on a 100%-quoted body", async () => {
    const allQuoted = `On Mon, Apr 28, 2026 at 9:00 AM Sender <s@x.com> wrote:
> The whole message
> is quote chain`;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;

    const r = await retrieveForDraft({
      from_addr: 'cust@example.com',
      subject: 'Re: order',
      body_text: allQuoted,
      persona_key: 'default',
      message_id: 'm1',
      draft_source: 'local',
    });

    expect(r.reason).toBe('inbound_too_thin');
  });

  it('respects RAG_MIN_INBOUND_CHARS override', async () => {
    process.env.RAG_MIN_INBOUND_CHARS = '2';
    // Same 'ok' body as the previous test — at floor=2 this should NOT be
    // gated. Mock the rest so the call proceeds to success.
    mockEmbedAndSearch({ hits: [] });

    const r = await retrieveForDraft({
      from_addr: 'cust@example.com',
      subject: 'Re: order',
      body_text: `ok

On Mon, Apr 28, 2026 wrote:
> chain`,
      persona_key: 'default',
      message_id: 'm1',
      draft_source: 'local',
    });
    // Empty hits → no_hits, NOT inbound_too_thin — the gate passed.
    expect(r.reason).toBe('no_hits');
  });

  it('passes the gate when body is substantive enough', async () => {
    mockEmbedAndSearch({ hits: [] });
    const r = await retrieveForDraft({
      from_addr: 'cust@example.com',
      subject: 'Re: order',
      body_text: 'Could you confirm the Q3 shipment timing? Our warehouse needs to plan for it.',
      persona_key: 'default',
      message_id: 'm1',
      draft_source: 'local',
    });
    // Substantive body → embed + search runs → returns no_hits (empty mock),
    // NOT the thin-inbound gate.
    expect(r.reason).toBe('no_hits');
  });
});

// =============================================================================
// STAQPRO-222 — H3 (same-thread suppression) + H5 (score-floor cutoff)
// =============================================================================

describe('retrieveForDraft H3 — same-thread suppression (STAQPRO-222)', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.OLLAMA_BASE_URL = 'http://test-ollama:11434';
    process.env.QDRANT_URL = 'http://test-qdrant:6333';
    delete process.env.RAG_DISABLED;
    delete process.env.RAG_CLOUD_ROUTE_ENABLED;
    delete process.env.RAG_MIN_INBOUND_CHARS;
    delete process.env.RAG_RETRIEVE_EXCLUDE_SAME_THREAD;
    delete process.env.RAG_MIN_SCORE;
    delete process.env.MAILBOX_OPERATOR_EMAIL;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends must_not thread_id filter when thread_id supplied (default-on)', async () => {
    // Default RAG_RETRIEVE_EXCLUDE_SAME_THREAD unset → on. Filter should fire.
    const captured: { value: unknown } = { value: null };
    mockEmbedAndSearch({ hits: [], capturedSearchBody: captured });

    await retrieveForDraft({
      ...baseInput,
      draft_source: 'local',
      thread_id: 'thread-abc',
    });

    const body = captured.value as {
      filter?: {
        must_not?: Array<{ has_id?: string[]; key?: string; match?: { value?: string } }>;
      };
    } | null;
    const clauses = body?.filter?.must_not ?? [];
    const threadClause = clauses.find((c) => c.key === 'thread_id');
    expect(threadClause?.match?.value).toBe('thread-abc');
    // STAQPRO-219 self-filter must still be present alongside.
    const hasIdClause = clauses.find((c) => Array.isArray(c.has_id));
    expect(hasIdClause?.has_id).toEqual([SELF_POINT_ID]);
  });

  it('omits thread_id filter when RAG_RETRIEVE_EXCLUDE_SAME_THREAD=0 (off)', async () => {
    process.env.RAG_RETRIEVE_EXCLUDE_SAME_THREAD = '0';
    const captured: { value: unknown } = { value: null };
    mockEmbedAndSearch({ hits: [], capturedSearchBody: captured });

    await retrieveForDraft({
      ...baseInput,
      draft_source: 'local',
      thread_id: 'thread-abc',
    });

    const body = captured.value as {
      filter?: {
        must_not?: Array<{ has_id?: string[]; key?: string }>;
      };
    } | null;
    const clauses = body?.filter?.must_not ?? [];
    // No thread_id clause expected.
    expect(clauses.find((c) => c.key === 'thread_id')).toBeUndefined();
    // STAQPRO-219 self-filter must still be present.
    expect(clauses.find((c) => Array.isArray(c.has_id))).toBeDefined();
  });

  it('omits thread_id filter when thread_id is not supplied (back-compat)', async () => {
    // Even with flag ON, no thread_id → no filter. Legacy callers retain
    // pre-222 retrieval behavior.
    const captured: { value: unknown } = { value: null };
    mockEmbedAndSearch({ hits: [], capturedSearchBody: captured });

    await retrieveForDraft({ ...baseInput, draft_source: 'local' });

    const body = captured.value as {
      filter?: {
        must_not?: Array<{ has_id?: string[]; key?: string }>;
      };
    } | null;
    const clauses = body?.filter?.must_not ?? [];
    expect(clauses.find((c) => c.key === 'thread_id')).toBeUndefined();
  });

  it('applies the thread_id filter to BOTH inbound and outbound H2 arms', async () => {
    process.env.MAILBOX_OPERATOR_EMAIL = 'op@heronlabsinc.com';
    const captured: unknown[] = [];
    mockMultiSearch({
      hitsBySearch: [
        {
          filterFingerprint: (f) => hasMustField(f, 'sender', 'cust@example.com'),
          hits: [],
        },
        {
          filterFingerprint: (f) =>
            hasMustField(f, 'sender', 'op@heronlabsinc.com') &&
            hasMustField(f, 'recipient', 'cust@example.com'),
          hits: [],
        },
      ],
      capturedBodies: captured,
    });

    await retrieveForDraft({
      ...baseInputForH2,
      draft_source: 'local',
      thread_id: 'thread-xyz',
    });

    expect(captured.length).toBe(2);
    for (const body of captured) {
      const must_not = (
        body as {
          filter?: { must_not?: Array<{ key?: string; match?: { value?: string } }> };
        }
      )?.filter?.must_not;
      const threadClause = (must_not ?? []).find((c) => c?.key === 'thread_id');
      expect(threadClause?.match?.value).toBe('thread-xyz');
    }
  });
});

describe('retrieveForDraft H5 — score-floor cutoff (STAQPRO-222)', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.OLLAMA_BASE_URL = 'http://test-ollama:11434';
    process.env.QDRANT_URL = 'http://test-qdrant:6333';
    delete process.env.RAG_DISABLED;
    delete process.env.RAG_CLOUD_ROUTE_ENABLED;
    delete process.env.RAG_MIN_INBOUND_CHARS;
    delete process.env.RAG_RETRIEVE_EXCLUDE_SAME_THREAD;
    delete process.env.RAG_MIN_SCORE;
    delete process.env.MAILBOX_OPERATOR_EMAIL;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns reason='below_score_floor' when every hit scores below the default 0.70", async () => {
    mockEmbedAndSearch({
      hits: [
        {
          id: 'pid-low-1',
          score: 0.69,
          payload: {
            message_id: 'm1',
            sender: 'cust@example.com',
            subject: 'borderline',
            body_excerpt: '...',
            sent_at: '2026-04-01T09:00:00Z',
            direction: 'inbound',
          },
        },
        {
          id: 'pid-low-2',
          score: 0.55,
          payload: {
            message_id: 'm2',
            sender: 'cust@example.com',
            subject: 'lower',
            body_excerpt: '...',
            sent_at: '2026-03-01T09:00:00Z',
            direction: 'inbound',
          },
        },
      ],
    });

    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('below_score_floor');
    expect(r.refs).toEqual([]);
  });

  it('drops sub-floor hits and keeps survivors when the result is mixed', async () => {
    mockEmbedAndSearch({
      hits: [
        {
          id: 'pid-keep',
          score: 0.78,
          payload: {
            message_id: 'm-keep',
            sender: 'cust@example.com',
            subject: 'above floor',
            body_excerpt: 'survives',
            sent_at: '2026-04-01T09:00:00Z',
            direction: 'inbound',
          },
        },
        {
          id: 'pid-drop',
          score: 0.5,
          payload: {
            message_id: 'm-drop',
            sender: 'cust@example.com',
            subject: 'below floor',
            body_excerpt: 'dropped',
            sent_at: '2026-03-01T09:00:00Z',
            direction: 'inbound',
          },
        },
      ],
    });

    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('ok');
    expect(r.refs.map((x) => x.point_id)).toEqual(['pid-keep']);
  });

  it('honors RAG_MIN_SCORE override (lowered floor keeps more)', async () => {
    process.env.RAG_MIN_SCORE = '0.50';
    mockEmbedAndSearch({
      hits: [
        {
          id: 'pid-mid',
          score: 0.65,
          payload: {
            message_id: 'm-mid',
            sender: 'cust@example.com',
            subject: 'mid',
            body_excerpt: 'kept-at-0.50',
            sent_at: '2026-04-01T09:00:00Z',
            direction: 'inbound',
          },
        },
      ],
    });

    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    // At default 0.70 this would be below_score_floor; at 0.50 it survives.
    expect(r.reason).toBe('ok');
    expect(r.refs.map((x) => x.point_id)).toEqual(['pid-mid']);
  });

  it("returns 'no_hits' (not 'below_score_floor') when Qdrant returned nothing", async () => {
    // Empty hits distinguishes from "Qdrant returned borderline relevant
    // matches we chose to drop." The eval surface needs both states.
    mockEmbedAndSearch({ hits: [] });
    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('no_hits');
  });

  it('boundary case: hit at exactly RAG_MIN_SCORE survives (>=)', async () => {
    // Inclusive floor: refs with score === minScore are kept (consistent
    // with the issue's `r.score >= minScore` reference snippet).
    mockEmbedAndSearch({
      hits: [
        {
          id: 'pid-boundary',
          score: 0.7,
          payload: {
            message_id: 'm-boundary',
            sender: 'cust@example.com',
            subject: 'at floor',
            body_excerpt: 'survives at-floor',
            sent_at: '2026-04-01T09:00:00Z',
            direction: 'inbound',
          },
        },
      ],
    });
    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('ok');
    expect(r.refs.map((x) => x.point_id)).toEqual(['pid-boundary']);
  });

  it('falls back to 0.70 when RAG_MIN_SCORE is malformed', async () => {
    // NaN guard — operator typos shouldn't open the floor wide.
    process.env.RAG_MIN_SCORE = 'not-a-number';
    mockEmbedAndSearch({
      hits: [
        {
          id: 'pid-low',
          score: 0.65,
          payload: {
            message_id: 'm-low',
            sender: 'cust@example.com',
            subject: 's',
            body_excerpt: '...',
            sent_at: '2026-04-01T09:00:00Z',
            direction: 'inbound',
          },
        },
      ],
    });
    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    // At fallback 0.70 the 0.65 hit is dropped.
    expect(r.reason).toBe('below_score_floor');
  });
});
