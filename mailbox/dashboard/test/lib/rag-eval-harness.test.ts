import { describe, expect, it, vi } from 'vitest';
import {
  aggregate,
  buildReport,
  buildSampleSql,
  cosineSimilarity,
  generateDraft,
  type PairRow,
  type PerPairScore,
  parseArgs,
  scorePair,
} from '@/scripts/rag-eval-harness';

// STAQPRO-198 — harness unit tests. Focus is the pure math + SQL builder +
// JSON report shape, plus a thin scorePair contract test with mocks. The
// live Postgres / Ollama / Qdrant integration is run on the appliance per
// docs/runbook/rag-eval.v0.1.0.md — never as part of `npm test`.

describe('cosineSimilarity — STAQPRO-198', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = [1, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
  });

  it('returns -1 for antiparallel vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
  });

  it('returns 0 on length mismatch (defensive — never NaN)', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it('returns 0 on zero-magnitude inputs', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('matches the dot-product shortcut on unit-normalized inputs', () => {
    // Hand-normalized golden pair — nomic-style 768-dim vectors are
    // unit-normalized, so dot product equals cosine. We assert that holds
    // here so any future "optimize to dot-product-only" refactor can be
    // verified against this case.
    const a = [0.6, 0.8, 0]; // |a| = 1
    const b = [0.6, 0, 0.8]; // |b| = 1
    const cos = cosineSimilarity(a, b);
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(cos).toBeCloseTo(dot, 10);
    expect(cos).toBeCloseTo(0.36, 10);
  });
});

describe('aggregate — STAQPRO-198', () => {
  it('returns zeros on empty input', () => {
    expect(aggregate([])).toEqual({
      count: 0,
      mean: 0,
      median: 0,
      p25: 0,
      p75: 0,
      min: 0,
      max: 0,
    });
  });

  it('computes correct mean / median / quartiles on a known set', () => {
    const xs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    const a = aggregate(xs);
    expect(a.count).toBe(9);
    expect(a.mean).toBeCloseTo(0.5, 10);
    expect(a.median).toBeCloseTo(0.5, 10);
    expect(a.min).toBeCloseTo(0.1, 10);
    expect(a.max).toBeCloseTo(0.9, 10);
    // p25 / p75 — linear interpolation (R-7 / Excel default).
    // Index = 0.25 * 8 = 2 → xs[2] = 0.3 exactly.
    expect(a.p25).toBeCloseTo(0.3, 10);
    expect(a.p75).toBeCloseTo(0.7, 10);
  });

  it('drops non-finite values (NaN / Infinity) defensively', () => {
    const a = aggregate([0.5, Number.NaN, 0.7, Number.POSITIVE_INFINITY]);
    expect(a.count).toBe(2);
    expect(a.mean).toBeCloseTo(0.6, 10);
  });
});

describe('buildSampleSql — STAQPRO-198', () => {
  it('joins sent_history → inbox_messages on the foreign key (not header chase)', () => {
    const sql = buildSampleSql(null);
    expect(sql).toMatch(/JOIN mailbox\.inbox_messages im ON im\.id = sh\.inbox_message_id/);
  });

  it("filters to source = 'backfill' rows only", () => {
    expect(buildSampleSql(null)).toContain("sh.source = 'backfill'");
  });

  it('drops pairs with empty bodies on either side', () => {
    const sql = buildSampleSql(null);
    expect(sql).toContain("COALESCE(sh.draft_sent, '') <> ''");
    expect(sql).toContain("COALESCE(im.body, '') <> ''");
  });

  it('omits LIMIT when limit is null (--limit all)', () => {
    expect(buildSampleSql(null)).not.toMatch(/LIMIT\s+\d/);
  });

  it('appends LIMIT N when caller passes a positive integer', () => {
    expect(buildSampleSql(50)).toMatch(/LIMIT 50/);
  });

  it('floors fractional limits and clamps to >= 1', () => {
    expect(buildSampleSql(50.7)).toMatch(/LIMIT 50/);
    expect(buildSampleSql(0)).toMatch(/LIMIT 1/);
  });

  it('orders by sent_at ASC for stable run-prefix selection', () => {
    expect(buildSampleSql(10)).toMatch(/ORDER BY sh\.sent_at ASC/);
  });
});

describe('parseArgs — STAQPRO-198 + STAQPRO-220 + STAQPRO-340', () => {
  it("defaults to limit='all' when no flag passed", () => {
    expect(parseArgs([])).toEqual({
      limit: 'all',
      judge: null,
      judge_only: false,
      trace_set: null,
      run_tag: null,
    });
  });

  it('accepts --limit all as an explicit choice', () => {
    expect(parseArgs(['--limit', 'all'])).toEqual({
      limit: 'all',
      judge: null,
      judge_only: false,
      trace_set: null,
      run_tag: null,
    });
  });

  it('parses --limit N as an integer', () => {
    expect(parseArgs(['--limit', '50'])).toEqual({
      limit: 50,
      judge: null,
      judge_only: false,
      trace_set: null,
      run_tag: null,
    });
  });

  it('rejects non-positive or non-numeric --limit values', () => {
    expect(() => parseArgs(['--limit', '0'])).toThrow();
    expect(() => parseArgs(['--limit', 'abc'])).toThrow();
    expect(() => parseArgs(['--limit', '-5'])).toThrow();
  });

  it('rejects --limit with no value', () => {
    expect(() => parseArgs(['--limit'])).toThrow();
  });

  // STAQPRO-220 — judge mode flags.

  it('parses --judge=haiku', () => {
    expect(parseArgs(['--judge=haiku'])).toEqual({
      limit: 'all',
      judge: 'haiku',
      judge_only: false,
      trace_set: null,
      run_tag: null,
    });
  });

  it('parses --judge gpt-oss as a separated value', () => {
    expect(parseArgs(['--judge', 'gpt-oss'])).toEqual({
      limit: 'all',
      judge: 'gpt-oss',
      judge_only: false,
      trace_set: null,
      run_tag: null,
    });
  });

  it('parses --judge-only=haiku and sets judge_only=true', () => {
    expect(parseArgs(['--judge-only=haiku'])).toEqual({
      limit: 'all',
      judge: 'haiku',
      judge_only: true,
      trace_set: null,
      run_tag: null,
    });
  });

  it('parses --judge-only gpt-oss separated form', () => {
    expect(parseArgs(['--judge-only', 'gpt-oss'])).toEqual({
      limit: 'all',
      judge: 'gpt-oss',
      judge_only: true,
      trace_set: null,
      run_tag: null,
    });
  });

  it('rejects an unknown --judge provider', () => {
    expect(() => parseArgs(['--judge=bogus'])).toThrow(/haiku, gpt-oss/);
    expect(() => parseArgs(['--judge', 'sonnet'])).toThrow();
  });

  it('rejects --judge with no value', () => {
    expect(() => parseArgs(['--judge'])).toThrow();
    expect(() => parseArgs(['--judge='])).toThrow();
  });

  it('combines --limit and --judge flags', () => {
    expect(parseArgs(['--limit', '10', '--judge=haiku'])).toEqual({
      limit: 10,
      judge: 'haiku',
      judge_only: false,
      trace_set: null,
      run_tag: null,
    });
  });

  // STAQPRO-340 — trace-set + run-tag flags.

  it('parses --trace-set <path> as separated value', () => {
    const parsed = parseArgs(['--trace-set', 'eval/t2-traces/v1.0']);
    expect(parsed.trace_set).toBe('eval/t2-traces/v1.0');
  });

  it('parses --trace-set=<path> as combined value', () => {
    const parsed = parseArgs(['--trace-set=eval/t2-traces/v1.0']);
    expect(parsed.trace_set).toBe('eval/t2-traces/v1.0');
  });

  it('rejects --trace-set with no value', () => {
    expect(() => parseArgs(['--trace-set'])).toThrow(/requires a value/);
  });

  it('parses --run-tag <tag> as separated value', () => {
    const parsed = parseArgs(['--run-tag', 'eval-qwen3-4b-ctx4k-2026-05-13']);
    expect(parsed.run_tag).toBe('eval-qwen3-4b-ctx4k-2026-05-13');
  });

  it('parses --run-tag=<tag> as combined value', () => {
    const parsed = parseArgs(['--run-tag=eval-test-run']);
    expect(parsed.run_tag).toBe('eval-test-run');
  });

  it('rejects --run-tag with no value', () => {
    expect(() => parseArgs(['--run-tag'])).toThrow(/requires a value/);
  });

  it('combines --trace-set --run-tag --judge --limit', () => {
    expect(
      parseArgs([
        '--trace-set',
        'eval/t2-traces/v1.0',
        '--run-tag',
        'eval-test',
        '--judge=haiku',
        '--limit',
        '5',
      ]),
    ).toEqual({
      limit: 5,
      judge: 'haiku',
      judge_only: false,
      trace_set: 'eval/t2-traces/v1.0',
      run_tag: 'eval-test',
    });
  });
});

describe('buildReport — STAQPRO-198', () => {
  const baseScore = (overrides: Partial<PerPairScore>): PerPairScore => ({
    sent_history_id: 1,
    inbox_message_id: 'm1',
    classification: 'inquiry',
    cosine: 0.5,
    rag_refs_count: 0,
    rag_reason: 'no_hits',
    draft_chars: 100,
    actual_chars: 120,
    status: 'ok',
    ...overrides,
  });

  it('produces a stable JSON-serializable shape', () => {
    const report = buildReport({
      mode: 'with-rag',
      drafter_model: 'qwen3:4b-ctx4k',
      embed_model: 'nomic-embed-text:v1.5',
      sample_size_requested: 'all',
      per_pair: [
        baseScore({ sent_history_id: 1, classification: 'inquiry', cosine: 0.7 }),
        baseScore({ sent_history_id: 2, classification: 'inquiry', cosine: 0.5 }),
        baseScore({ sent_history_id: 3, classification: 'reorder', cosine: 0.9 }),
        baseScore({
          sent_history_id: 4,
          classification: null,
          cosine: null,
          status: 'draft_failed',
          error: 'boom',
        }),
      ],
    });

    expect(report.mode).toBe('with-rag');
    expect(report.drafter_model).toBe('qwen3:4b-ctx4k');
    expect(report.embed_model).toBe('nomic-embed-text:v1.5');
    expect(report.sample_size_requested).toBe('all');
    expect(report.sample_size_actual).toBe(4);
    expect(report.aggregates_global.count).toBe(3); // failed pair excluded
    expect(report.aggregates_global.mean).toBeCloseTo((0.7 + 0.5 + 0.9) / 3, 10);
    expect(report.aggregates_by_category.inquiry.count).toBe(2);
    expect(report.aggregates_by_category.reorder.count).toBe(1);
    expect(report.aggregates_by_category.unclassified).toBeUndefined(); // null cosine drops the row
    expect(report.status_counts).toEqual({
      ok: 3,
      draft_failed: 1,
      embed_failed: 0,
      error: 0,
      judge_only: 0,
      judge_failed: 0,
      judge_rate_limited: 0,
    });
    // ISO-8601 with 'Z' — verify it's parseable, since the file path uses it.
    expect(new Date(report.generated_at).toString()).not.toBe('Invalid Date');
    // Whole report must be JSON-serializable (no Maps, no functions).
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
  });

  it("groups null classifications under 'unclassified' when cosine is present", () => {
    const report = buildReport({
      mode: 'no-rag',
      drafter_model: 'qwen3:4b-ctx4k',
      embed_model: 'nomic-embed-text:v1.5',
      sample_size_requested: 5,
      per_pair: [
        baseScore({ sent_history_id: 1, classification: null, cosine: 0.4 }),
        baseScore({ sent_history_id: 2, classification: null, cosine: 0.6 }),
      ],
    });
    expect(report.aggregates_by_category.unclassified.count).toBe(2);
    expect(report.aggregates_by_category.unclassified.mean).toBeCloseTo(0.5, 10);
  });

  // STAQPRO-220 — judge aggregates.

  it('produces judge_aggregates_global only when judge_provider is supplied', () => {
    const cosineOnly = buildReport({
      mode: 'with-rag',
      drafter_model: 'qwen3:4b-ctx4k',
      embed_model: 'nomic-embed-text:v1.5',
      sample_size_requested: 'all',
      per_pair: [baseScore({ cosine: 0.5 })],
    });
    expect(cosineOnly.judge_provider).toBeUndefined();
    expect(cosineOnly.judge_aggregates_global).toBeUndefined();
    expect(cosineOnly.judge_aggregates_by_category).toBeUndefined();
  });

  it('aggregates judge_score over judge_status=ok pairs only and counts judge_failed', () => {
    const report = buildReport({
      mode: 'with-rag',
      drafter_model: 'qwen3:4b-ctx4k',
      embed_model: 'nomic-embed-text:v1.5',
      sample_size_requested: 'all',
      judge_provider: 'haiku',
      per_pair: [
        baseScore({
          sent_history_id: 1,
          classification: 'inquiry',
          cosine: 0.7,
          judge_provider: 'haiku',
          judge_status: 'ok',
          judge_score: 6,
          judge_voice: 2,
          judge_facts: 3,
          judge_length: 1,
          judge_rationale: 'good',
        }),
        baseScore({
          sent_history_id: 2,
          classification: 'inquiry',
          cosine: 0.6,
          judge_provider: 'haiku',
          judge_status: 'ok',
          judge_score: 8,
          judge_voice: 3,
          judge_facts: 3,
          judge_length: 2,
          judge_rationale: 'great',
        }),
        baseScore({
          sent_history_id: 3,
          classification: 'reorder',
          cosine: 0.9,
          judge_provider: 'haiku',
          judge_status: 'parse_failed',
          judge_error: 'bad json',
        }),
        baseScore({
          sent_history_id: 4,
          classification: 'reorder',
          cosine: 0.85,
          judge_provider: 'haiku',
          judge_status: 'call_failed',
          judge_error: 'auth',
        }),
        // STAQPRO-224 — rate_limited (was previously folded into call_failed).
        baseScore({
          sent_history_id: 5,
          classification: 'reorder',
          cosine: 0.8,
          judge_provider: 'haiku',
          judge_status: 'rate_limited',
          judge_error: 'anthropic 429: throttled',
        }),
      ],
    });

    expect(report.judge_provider).toBe('haiku');
    // ok pairs only — 6 and 8 → mean 7
    expect(report.judge_aggregates_global?.count).toBe(2);
    expect(report.judge_aggregates_global?.mean).toBeCloseTo(7, 10);
    expect(report.judge_aggregates_by_category?.inquiry.count).toBe(2);
    // No 'ok' judge in reorder, so the per-category bucket should be absent.
    expect(report.judge_aggregates_by_category?.reorder).toBeUndefined();
    // judge_failed counts parse_failed + call_failed + rate_limited (any non-ok).
    expect(report.status_counts.judge_failed).toBe(3);
    // STAQPRO-224 — rate_limited bucket is a strict subset of judge_failed.
    expect(report.status_counts.judge_rate_limited).toBe(1);
  });
});

describe('scorePair — STAQPRO-198', () => {
  const pair: PairRow = {
    sent_history_id: 42,
    sent_message_id: 'reply-msg-1',
    actual_reply_body: 'Thanks for the order — confirmed for shipment Friday.',
    reply_sent_at: '2026-04-15T10:00:00Z',
    inbox_id: 7,
    inbox_message_id: 'inbound-msg-1',
    inbox_from: 'cust@example.com',
    inbox_subject: 'When will my order ship?',
    inbox_body: 'Hi — checking on the order I placed Monday. When does it ship?',
    inbox_classification: 'inquiry',
    inbox_confidence: 0.92,
    inbox_thread_id: 'thread-1',
  };

  // Fixed unit vectors so the test asserts cosine=1 exactly without
  // floating-point fuzz.
  const unitX = (() => {
    const v = new Array(768).fill(0);
    v[0] = 1;
    return v;
  })();

  it('returns ok with cosine=1 when draft and actual both embed identically', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: { content: 'Confirmed for Friday — thanks for the order.' } }),
    );
    const embedMock = vi.fn(async () => unitX);
    const retrieveMock = vi.fn(async () => ({
      refs: [],
      reason: 'no_hits' as const,
      kb_refs: [],
      kb_reason: 'no_hits' as const,
    }));
    const personaMock = vi.fn(async () => ({
      tone: 'concise',
      signoff: '— Heron Labs',
      operator_first_name: 'Heron Labs team',
      operator_brand: 'Heron Labs',
      business_description: '',
    }));

    const score = await scorePair(pair, {
      fetchFn: fetchMock as unknown as typeof fetch,
      embedFn: embedMock as unknown as typeof import('@/lib/rag/embed').embedText,
      retrieve: retrieveMock,
      resolvePersona: personaMock,
    });

    expect(score.status).toBe('ok');
    expect(score.cosine).toBeCloseTo(1, 10);
    expect(score.rag_refs_count).toBe(0);
    expect(score.rag_reason).toBe('no_hits');
    expect(score.classification).toBe('inquiry');
    expect(score.draft_chars).toBeGreaterThan(0);
    expect(score.actual_chars).toBe(pair.actual_reply_body.length);
    // One Ollama call (the drafter); embed called twice (draft + actual).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(embedMock).toHaveBeenCalledTimes(2);
  });

  it('records draft_failed on Ollama 5xx without calling embed', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    const embedMock = vi.fn(async () => unitX);
    const retrieveMock = vi.fn(async () => ({
      refs: [],
      reason: 'no_hits' as const,
      kb_refs: [],
      kb_reason: 'no_hits' as const,
    }));
    const personaMock = vi.fn(async () => ({
      tone: 'concise',
      signoff: '— Heron Labs',
      operator_first_name: 'Heron Labs team',
      operator_brand: 'Heron Labs',
      business_description: '',
    }));

    const score = await scorePair(pair, {
      fetchFn: fetchMock as unknown as typeof fetch,
      embedFn: embedMock as unknown as typeof import('@/lib/rag/embed').embedText,
      retrieve: retrieveMock,
      resolvePersona: personaMock,
    });

    expect(score.status).toBe('draft_failed');
    expect(score.cosine).toBeNull();
    expect(score.error).toMatch(/500/);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('records embed_failed when embedFn returns null', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: { content: 'Confirmed for Friday.' } }),
    );
    const embedMock = vi.fn(async () => null);
    const retrieveMock = vi.fn(async () => ({
      refs: [],
      reason: 'no_hits' as const,
      kb_refs: [],
      kb_reason: 'no_hits' as const,
    }));
    const personaMock = vi.fn(async () => ({
      tone: 'concise',
      signoff: '— Heron Labs',
      operator_first_name: 'Heron Labs team',
      operator_brand: 'Heron Labs',
      business_description: '',
    }));

    const score = await scorePair(pair, {
      fetchFn: fetchMock as unknown as typeof fetch,
      embedFn: embedMock as unknown as typeof import('@/lib/rag/embed').embedText,
      retrieve: retrieveMock,
      resolvePersona: personaMock,
    });

    expect(score.status).toBe('embed_failed');
    expect(score.cosine).toBeNull();
  });

  it('propagates retrieval refs_count + reason through to the score', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: { content: 'Confirmed for Friday — thanks.' } }),
    );
    const embedMock = vi.fn(async () => unitX);
    const retrieveMock = vi.fn(async () => ({
      refs: [
        {
          point_id: 'pid-1',
          source: 'past',
          excerpt: 'last order',
          score: 0.9,
          direction: 'outbound' as const,
          sent_at: '2026-03-01T00:00:00Z',
        },
      ],
      reason: 'ok' as const,
      // STAQPRO-148 — KB shape required by the post-merge RetrievalResult.
      // Empty here since the test asserts only the email refs surface.
      kb_refs: [],
      kb_reason: 'no_hits' as const,
    }));
    const personaMock = vi.fn(async () => ({
      tone: 'concise',
      signoff: '— Heron Labs',
      operator_first_name: 'Heron Labs team',
      operator_brand: 'Heron Labs',
      business_description: '',
    }));

    const score = await scorePair(pair, {
      fetchFn: fetchMock as unknown as typeof fetch,
      embedFn: embedMock as unknown as typeof import('@/lib/rag/embed').embedText,
      retrieve: retrieveMock,
      resolvePersona: personaMock,
    });

    expect(score.rag_refs_count).toBe(1);
    expect(score.rag_reason).toBe('ok');
  });

  // STAQPRO-220 — judge integration through scorePair.

  it('populates judge fields when --judge=haiku is enabled alongside cosine', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: { content: 'Confirmed for Friday.' } }),
    );
    const embedMock = vi.fn(async () => unitX);
    const retrieveMock = vi.fn(async () => ({
      refs: [],
      reason: 'no_hits' as const,
      kb_refs: [],
      kb_reason: 'no_hits' as const,
    }));
    const personaMock = vi.fn(async () => ({
      tone: 'concise',
      signoff: '— Heron Labs',
      operator_first_name: 'Heron Labs team',
      operator_brand: 'Heron Labs',
      business_description: '',
    }));
    const judgeMock = vi.fn(async () => ({
      status: 'ok' as const,
      scores: {
        voice_match: 2,
        factual_alignment: 3,
        length_appropriateness: 1,
        rationale: 'close',
      },
    }));

    const score = await scorePair(
      pair,
      {
        fetchFn: fetchMock as unknown as typeof fetch,
        embedFn: embedMock as unknown as typeof import('@/lib/rag/embed').embedText,
        retrieve: retrieveMock,
        resolvePersona: personaMock,
        judgeFn: judgeMock as unknown as typeof import('@/lib/drafting/judge').callJudge,
      },
      { judge: 'haiku' },
    );

    expect(score.status).toBe('ok');
    expect(score.cosine).toBeCloseTo(1, 10);
    expect(score.judge_provider).toBe('haiku');
    expect(score.judge_status).toBe('ok');
    expect(score.judge_score).toBe(6); // 2+3+1
    expect(score.judge_voice).toBe(2);
    expect(score.judge_facts).toBe(3);
    expect(score.judge_length).toBe(1);
    expect(score.judge_rationale).toBe('close');
    expect(judgeMock).toHaveBeenCalledTimes(1);
  });

  it('judge_only=true skips embeds and yields status=judge_only with cosine=null', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: { content: 'Confirmed for Friday.' } }),
    );
    const embedMock = vi.fn(async () => unitX);
    const retrieveMock = vi.fn(async () => ({
      refs: [],
      reason: 'no_hits' as const,
      kb_refs: [],
      kb_reason: 'no_hits' as const,
    }));
    const personaMock = vi.fn(async () => ({
      tone: 'concise',
      signoff: '— Heron Labs',
      operator_first_name: 'Heron Labs team',
      operator_brand: 'Heron Labs',
      business_description: '',
    }));
    const judgeMock = vi.fn(async () => ({
      status: 'ok' as const,
      scores: {
        voice_match: 3,
        factual_alignment: 2,
        length_appropriateness: 2,
        rationale: 'fine',
      },
    }));

    const score = await scorePair(
      pair,
      {
        fetchFn: fetchMock as unknown as typeof fetch,
        embedFn: embedMock as unknown as typeof import('@/lib/rag/embed').embedText,
        retrieve: retrieveMock,
        resolvePersona: personaMock,
        judgeFn: judgeMock as unknown as typeof import('@/lib/drafting/judge').callJudge,
      },
      { judge: 'haiku', judge_only: true },
    );

    expect(score.status).toBe('judge_only');
    expect(score.cosine).toBeNull();
    expect(embedMock).not.toHaveBeenCalled();
    expect(score.judge_score).toBe(7);
  });

  it('judge call_failed does NOT poison cosine — pair still ok', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: { content: 'Confirmed for Friday.' } }),
    );
    const embedMock = vi.fn(async () => unitX);
    const retrieveMock = vi.fn(async () => ({
      refs: [],
      reason: 'no_hits' as const,
      kb_refs: [],
      kb_reason: 'no_hits' as const,
    }));
    const personaMock = vi.fn(async () => ({
      tone: 'concise',
      signoff: '— Heron Labs',
      operator_first_name: 'Heron Labs team',
      operator_brand: 'Heron Labs',
      business_description: '',
    }));
    const judgeMock = vi.fn(async () => ({
      // Generic call failure (not 429 — those are now `rate_limited` per
      // STAQPRO-224). 5xx + network errors still surface as `call_failed`.
      status: 'call_failed' as const,
      scores: null,
      error: 'anthropic 500',
    }));

    const score = await scorePair(
      pair,
      {
        fetchFn: fetchMock as unknown as typeof fetch,
        embedFn: embedMock as unknown as typeof import('@/lib/rag/embed').embedText,
        retrieve: retrieveMock,
        resolvePersona: personaMock,
        judgeFn: judgeMock as unknown as typeof import('@/lib/drafting/judge').callJudge,
      },
      { judge: 'haiku' },
    );

    expect(score.status).toBe('ok');
    expect(score.cosine).toBeCloseTo(1, 10);
    expect(score.judge_status).toBe('call_failed');
    expect(score.judge_score).toBeUndefined();
    expect(score.judge_error).toBe('anthropic 500');
  });
});

describe('generateDraft — STAQPRO-198', () => {
  it('POSTs to <baseUrl>/api/chat with the assembled messages payload', async () => {
    const pair: PairRow = {
      sent_history_id: 1,
      sent_message_id: 'rmsg',
      actual_reply_body: 'reply',
      reply_sent_at: '2026-04-01T00:00:00Z',
      inbox_id: 1,
      inbox_message_id: 'imsg',
      inbox_from: 'cust@example.com',
      inbox_subject: 'subj',
      inbox_body: 'body',
      inbox_classification: 'inquiry',
      inbox_confidence: 0.9,
      inbox_thread_id: 'thread-1',
    };
    const fetchMock = vi.fn(async () => jsonResponse({ message: { content: 'drafted' } }));
    const retrieveMock = vi.fn(async () => ({
      refs: [],
      reason: 'no_hits' as const,
      kb_refs: [],
      kb_reason: 'no_hits' as const,
    }));
    const personaMock = vi.fn(async () => ({
      tone: 'concise',
      signoff: '— Heron Labs',
      operator_first_name: 'Heron Labs team',
      operator_brand: 'Heron Labs',
      business_description: '',
    }));

    const out = await generateDraft(pair, {
      fetchFn: fetchMock as unknown as typeof fetch,
      retrieve: retrieveMock,
      resolvePersona: personaMock,
    });

    expect(out.body).toBe('drafted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/chat$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: ReadonlyArray<{ role: string; content: string }>;
      stream: boolean;
    };
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    // The user prompt must include the inbound subject + body so the local
    // model has the inbound to draft against.
    expect(body.messages[1].content).toContain('subj');
    expect(body.messages[1].content).toContain('body');
  });
});

// =============================================================================
// STAQPRO-340 — perf metrics + run_tag + trace_set provenance on the report.
// =============================================================================

describe('buildReport — STAQPRO-340 (perf metrics + run_tag)', () => {
  const baseScore = (overrides: Partial<PerPairScore>): PerPairScore => ({
    sent_history_id: 1,
    inbox_message_id: 'm1',
    classification: 'inquiry',
    cosine: 0.5,
    rag_refs_count: 0,
    rag_reason: 'no_hits',
    draft_chars: 100,
    actual_chars: 120,
    status: 'ok',
    ...overrides,
  });

  it('derives run_tag from drafter_model + date when --run-tag omitted', () => {
    const report = buildReport({
      mode: 'with-rag',
      drafter_model: 'qwen3:4b-ctx4k',
      embed_model: 'nomic-embed-text:v1.5',
      sample_size_requested: 'all',
      per_pair: [baseScore({ cosine: 0.5 })],
    });
    // qwen3:4b-ctx4k → qwen3-4b-ctx4k (`:` → `-`, lowercase)
    expect(report.run_tag).toMatch(/^eval-qwen3-4b-ctx4k-\d{4}-\d{2}-\d{2}$/);
  });

  it('uses explicit run_tag verbatim when supplied', () => {
    const report = buildReport({
      mode: 'with-rag',
      drafter_model: 'qwen3:4b-ctx4k',
      embed_model: 'nomic-embed-text:v1.5',
      sample_size_requested: 'all',
      per_pair: [baseScore({ cosine: 0.5 })],
      run_tag: 'eval-my-specific-run',
    });
    expect(report.run_tag).toBe('eval-my-specific-run');
  });

  it('aggregates perf metrics only over pairs that captured them', () => {
    const report = buildReport({
      mode: 'with-rag',
      drafter_model: 'qwen3:4b-ctx4k',
      embed_model: 'nomic-embed-text:v1.5',
      sample_size_requested: 'all',
      per_pair: [
        baseScore({
          sent_history_id: 1,
          latency_ms: 1200,
          tokens_in: 500,
          tokens_out: 100,
          tokens_per_second: 20,
        }),
        baseScore({
          sent_history_id: 2,
          latency_ms: 1800,
          tokens_in: 700,
          tokens_out: 150,
          tokens_per_second: 15,
        }),
        // No perf — simulates a draft_failed pair that should be excluded.
        baseScore({ sent_history_id: 3, cosine: null, status: 'draft_failed' }),
      ],
    });

    expect(report.tokens_per_second_aggregates?.count).toBe(2);
    expect(report.tokens_per_second_aggregates?.mean).toBeCloseTo(17.5, 5);
    expect(report.latency_ms_aggregates?.count).toBe(2);
    expect(report.latency_ms_aggregates?.mean).toBeCloseTo(1500, 5);
    expect(report.tokens_in_aggregates?.count).toBe(2);
    expect(report.tokens_out_aggregates?.count).toBe(2);
  });

  it('omits perf aggregate keys entirely when no pair captured perf', () => {
    const report = buildReport({
      mode: 'with-rag',
      drafter_model: 'qwen3:4b-ctx4k',
      embed_model: 'nomic-embed-text:v1.5',
      sample_size_requested: 'all',
      per_pair: [baseScore({ cosine: 0.5 })],
    });
    expect(report.latency_ms_aggregates).toBeUndefined();
    expect(report.tokens_per_second_aggregates).toBeUndefined();
  });

  it('carries trace_set provenance onto the report when supplied', () => {
    const report = buildReport({
      mode: 'with-rag',
      drafter_model: 'qwen3:4b-ctx4k',
      embed_model: 'nomic-embed-text:v1.5',
      sample_size_requested: 'all',
      per_pair: [baseScore({ cosine: 0.5 })],
      trace_set: {
        dir: 'eval/t2-traces/v1.0',
        set_version: 'v1.0',
        set_sha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        source_appliance: 'mailbox1',
        count: 50,
      },
    });
    expect(report.trace_set?.set_version).toBe('v1.0');
    expect(report.trace_set?.count).toBe(50);
  });
});

describe('generateDraft — STAQPRO-340 (perf capture)', () => {
  const pair: PairRow = {
    sent_history_id: 1,
    sent_message_id: 'reply-1',
    actual_reply_body: 'reply',
    reply_sent_at: '2026-04-15T10:00:00Z',
    inbox_id: 1,
    inbox_message_id: 'inbound-1',
    inbox_from: 'cust@example.com',
    inbox_subject: 'subj',
    inbox_body: 'body',
    inbox_classification: 'inquiry',
    inbox_confidence: 0.9,
    inbox_thread_id: 'thread-1',
  };

  const persona = {
    tone: 'concise',
    signoff: '— Heron Labs',
    operator_first_name: 'Heron Labs team',
    operator_brand: 'Heron Labs',
    business_description: '',
  };

  it('captures tokens_in / tokens_out / tokens_per_second when Ollama returns metric fields', async () => {
    // eval_duration in ns: 5s of generation for 100 output tokens = 20 t/s.
    const ollamaResp = {
      message: { content: 'draft text' },
      prompt_eval_count: 500,
      eval_count: 100,
      eval_duration: 5_000_000_000,
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(ollamaResp), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const retrieveMock = vi.fn(async () => ({
      refs: [],
      reason: 'no_hits' as const,
      kb_refs: [],
      kb_reason: 'no_hits' as const,
    }));
    const personaMock = vi.fn(async () => persona);

    const result = await generateDraft(pair, {
      fetchFn: fetchMock as unknown as typeof fetch,
      retrieve: retrieveMock,
      resolvePersona: personaMock,
    });

    expect(result.body).toBe('draft text');
    expect(result.perf.tokens_in).toBe(500);
    expect(result.perf.tokens_out).toBe(100);
    expect(result.perf.tokens_per_second).toBeCloseTo(20, 5);
    expect(result.perf.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('omits perf fields when Ollama response lacks them (cloud endpoint)', async () => {
    // Cloud endpoints (Anthropic via Ollama-shape adapter) may omit the
    // perf counters. The harness should still record latency_ms (always
    // wall-clocked) but leave tokens_* undefined so aggregate counts
    // exclude these pairs.
    const cloudResp = { message: { content: 'cloud draft' } };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(cloudResp), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const retrieveMock = vi.fn(async () => ({
      refs: [],
      reason: 'no_hits' as const,
      kb_refs: [],
      kb_reason: 'no_hits' as const,
    }));
    const personaMock = vi.fn(async () => persona);

    const result = await generateDraft(pair, {
      fetchFn: fetchMock as unknown as typeof fetch,
      retrieve: retrieveMock,
      resolvePersona: personaMock,
    });

    expect(result.body).toBe('cloud draft');
    expect(result.perf.tokens_in).toBeUndefined();
    expect(result.perf.tokens_out).toBeUndefined();
    expect(result.perf.tokens_per_second).toBeUndefined();
    expect(typeof result.perf.latency_ms).toBe('number');
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
