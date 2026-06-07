// dashboard/test/lib/bake-off.test.ts
//
// STAQPRO-342 — unit tests for the bake-off harness lib. Focus: per-trace
// metric capture, function-call validity heuristic, aggregate computation,
// timeout + error capture (never throws — errors are status fields).
//
// Live llama.cpp HTTP calls are out of scope here; tests inject a stub
// fetch. End-to-end exercise against a real llama.cpp server happens at
// the operator-driven Phase 3 sweep.

import { describe, expect, it, vi } from 'vitest';

import {
  aggregateBakeOffResults,
  type BakeOffPerTraceResult,
  type BakeOffPrompt,
  checkFunctionCallValid,
  type ModelEndpoint,
  runBakeOffOnTrace,
} from '@/lib/eval/bake-off';
import { TRACE_FORMAT_VERSION, type Trace } from '@/lib/eval/trace-set';

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    format_version: TRACE_FORMAT_VERSION,
    workflow_category: 'draft-reply',
    classification: 'inquiry',
    inbox_message_id: 'TEST-msg-0001',
    inbox_thread_id: 'TEST-thread-0001',
    inbox_from: 'alice@example.com',
    inbox_subject: 'subject',
    inbox_body: 'body text',
    inbox_confidence: 0.92,
    actual_reply_body: 'reply body',
    reply_sent_at: '2026-03-14T12:00:00.000Z',
    provenance: {
      appliance: 'mailbox1',
      sent_history_id: 412,
      inbox_id: 938,
      extracted_at: '2026-05-13T00:00:00.000Z',
      scrub_counts: { phone: 0, ssn: 0, card: 0 },
    },
    ...overrides,
  };
}

const ENDPOINT: ModelEndpoint = {
  model: 'test-model-4b-Q4_K_M.gguf',
  baseUrl: 'http://localhost:8080',
  quantization: 'Q4_K_M',
  context_length: 4096,
  runtime_sha: 'deadbeef',
  gguf_sha256: 'aaaa1111',
};

const PROMPT: BakeOffPrompt = {
  messages: [
    { role: 'system', content: 'You are a drafting assistant.' },
    { role: 'user', content: 'Reply to: hello.' },
  ],
  options: { temperature: 0, seed: 42 },
};

// ── checkFunctionCallValid ──────────────────────────────────────────────

describe('checkFunctionCallValid — STAQPRO-342', () => {
  it('returns null when caller did not request a function-call envelope', () => {
    expect(checkFunctionCallValid('anything', false)).toBe(null);
  });

  it('returns true for clean JSON with a body field', () => {
    expect(checkFunctionCallValid('{"body":"reply text","subject":"re: x"}', true)).toBe(true);
  });

  it('returns true when JSON is wrapped in prose preamble', () => {
    const out = 'Sure, here is the reply:\n{"body":"reply text"}\nThanks.';
    expect(checkFunctionCallValid(out, true)).toBe(true);
  });

  it('returns true for multi-block output — lazy match grabs the first block (MBOX-113)', () => {
    // Greedy `/\{[\s\S]*\}/` would span from the first `{` to the LAST `}`,
    // producing `{"body":"reply"} extra {"junk":1}` which fails JSON.parse.
    // Lazy `/\{[\s\S]*?\}/` stops at the first `}` → valid first block.
    const out = '{"body":"reply"} extra {"junk":1}';
    expect(checkFunctionCallValid(out, true)).toBe(true);
  });

  it('returns true for multi-block output wrapped in prose (MBOX-113)', () => {
    const out = 'Here you go:\n{"body":"reply text"}\nAnd some trailing {"noise":true}';
    expect(checkFunctionCallValid(out, true)).toBe(true);
  });

  it('returns false on empty output', () => {
    expect(checkFunctionCallValid('', true)).toBe(false);
    expect(checkFunctionCallValid('   ', true)).toBe(false);
  });

  it('returns false when output is non-JSON prose', () => {
    expect(checkFunctionCallValid('Just plain text, no JSON.', true)).toBe(false);
  });

  it('returns false when JSON is an array (not an object)', () => {
    expect(checkFunctionCallValid('["body","reply text"]', true)).toBe(false);
  });

  it('returns false when JSON object is missing body field', () => {
    expect(checkFunctionCallValid('{"subject":"re: x"}', true)).toBe(false);
  });

  it('returns false when body is empty string', () => {
    expect(checkFunctionCallValid('{"body":""}', true)).toBe(false);
  });
});

// ── runBakeOffOnTrace ───────────────────────────────────────────────────

describe('runBakeOffOnTrace — STAQPRO-342', () => {
  it('captures output, latency, and tokens on a successful call', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"body":"reply"}' } }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
          timings: { prompt_n: 12, predicted_n: 4, predicted_ms: 200 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const result = await runBakeOffOnTrace(
      makeTrace(),
      'trace-0001.trace.json',
      PROMPT,
      ENDPOINT,
      true,
      { fetchFn },
    );

    expect(result.status).toBe('ok');
    expect(result.error).toBe(null);
    expect(result.output).toBe('{"body":"reply"}');
    expect(result.function_call_valid).toBe(true);
    expect(result.tokens_in).toBe(12);
    expect(result.tokens_out).toBe(4);
    // predicted_n=4, predicted_ms=200 → 4/(0.2)=20 tokens/s
    expect(result.tokens_per_second).toBeCloseTo(20, 5);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);

    // Provenance fields denormalized from the endpoint.
    expect(result.model).toBe(ENDPOINT.model);
    expect(result.quantization).toBe('Q4_K_M');
    expect(result.context_length).toBe(4096);
    expect(result.runtime_sha).toBe('deadbeef');

    // URL: hits the OpenAI-compat endpoint (NOT the bare /completion path).
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('http://localhost:8080/v1/chat/completions');
    const body = JSON.parse(call[1]!.body as string);
    expect(body.model).toBe(ENDPOINT.model);
    expect(body.messages).toEqual(PROMPT.messages);
    expect(body.temperature).toBe(0);
    expect(body.seed).toBe(42);
    expect(body.stream).toBe(false);
  });

  it('falls back to usage counters when timings are absent', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"body":"reply"}' } }],
          usage: { prompt_tokens: 22, completion_tokens: 8 },
          // timings: undefined
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await runBakeOffOnTrace(
      makeTrace(),
      'trace-0002.trace.json',
      PROMPT,
      ENDPOINT,
      true,
      { fetchFn },
    );

    expect(result.tokens_in).toBe(22);
    expect(result.tokens_out).toBe(8);
    // No predicted_ms → no t/s computable.
    expect(result.tokens_per_second).toBe(null);
  });

  it('captures HTTP 5xx as status=http_5xx and never throws', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response('upstream blew up', { status: 503 }),
      ) as unknown as typeof fetch;

    const result = await runBakeOffOnTrace(
      makeTrace(),
      'trace-0003.trace.json',
      PROMPT,
      ENDPOINT,
      true,
      { fetchFn },
    );

    expect(result.status).toBe('http_5xx');
    expect(result.error).toContain('503');
    expect(result.output).toBe('');
    expect(result.function_call_valid).toBe(false);
  });

  it('captures HTTP 4xx as status=http_4xx', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response('bad request', { status: 400 })) as unknown as typeof fetch;

    const result = await runBakeOffOnTrace(
      makeTrace(),
      'trace-0004.trace.json',
      PROMPT,
      ENDPOINT,
      true,
      { fetchFn },
    );

    expect(result.status).toBe('http_4xx');
  });

  it('captures fetch rejection as status=fetch_error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('econnrefused')) as unknown as typeof fetch;

    const result = await runBakeOffOnTrace(
      makeTrace(),
      'trace-0005.trace.json',
      PROMPT,
      ENDPOINT,
      true,
      { fetchFn },
    );

    expect(result.status).toBe('fetch_error');
    expect(result.error).toContain('econnrefused');
  });

  it('captures abort/timeout as status=timeout', async () => {
    const fetchFn = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }) as unknown as typeof fetch;

    const result = await runBakeOffOnTrace(
      makeTrace(),
      'trace-0006.trace.json',
      PROMPT,
      ENDPOINT,
      true,
      { fetchFn, timeoutMs: 10 },
    );

    expect(result.status).toBe('timeout');
  });

  it('returns function_call_valid=null when expectFunctionCall=false', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'free-text reply' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await runBakeOffOnTrace(
      makeTrace(),
      'trace-0007.trace.json',
      PROMPT,
      ENDPOINT,
      false, // free-text mode
      { fetchFn },
    );

    expect(result.status).toBe('ok');
    expect(result.function_call_valid).toBe(null);
    expect(result.output).toBe('free-text reply');
  });
});

// ── aggregateBakeOffResults ─────────────────────────────────────────────

function makeResult(over: Partial<BakeOffPerTraceResult> = {}): BakeOffPerTraceResult {
  return {
    trace_filename: 't.trace.json',
    inbox_message_id: 'm',
    classification: 'inquiry',
    workflow_category: 'draft-reply',
    model: 'm',
    quantization: 'Q4_K_M',
    context_length: 4096,
    runtime_sha: 'sha',
    output: '',
    function_call_valid: null,
    latency_ms: 100,
    tokens_in: null,
    tokens_out: null,
    tokens_per_second: null,
    status: 'ok',
    error: null,
    ...over,
  };
}

describe('aggregateBakeOffResults — STAQPRO-342', () => {
  it('returns zeros / nulls for an empty input', () => {
    const agg = aggregateBakeOffResults([]);
    expect(agg.ok_rate).toBe(0);
    expect(agg.function_call_success_rate).toBe(null);
    expect(agg.mean_tokens_per_second).toBe(null);
    expect(agg.p50_latency_ms).toBe(null);
    expect(agg.p95_latency_ms).toBe(null);
  });

  it('computes ok_rate as ok_count / total', () => {
    const agg = aggregateBakeOffResults([
      makeResult({ status: 'ok' }),
      makeResult({ status: 'ok' }),
      makeResult({ status: 'http_5xx' }),
      makeResult({ status: 'timeout' }),
    ]);
    expect(agg.ok_rate).toBeCloseTo(0.5, 5);
  });

  it('computes function-call success only over function-call-eligible oks', () => {
    const agg = aggregateBakeOffResults([
      makeResult({ status: 'ok', function_call_valid: true }),
      makeResult({ status: 'ok', function_call_valid: true }),
      makeResult({ status: 'ok', function_call_valid: false }),
      makeResult({ status: 'ok', function_call_valid: null }), // free-text — excluded
      makeResult({ status: 'http_5xx', function_call_valid: false }), // error — excluded
    ]);
    expect(agg.function_call_success_rate).toBeCloseTo(2 / 3, 5);
  });

  it('returns null fc-success-rate when no traces requested function-call', () => {
    const agg = aggregateBakeOffResults([
      makeResult({ status: 'ok', function_call_valid: null }),
      makeResult({ status: 'ok', function_call_valid: null }),
    ]);
    expect(agg.function_call_success_rate).toBe(null);
  });

  it('computes mean t/s over oks with t/s data', () => {
    const agg = aggregateBakeOffResults([
      makeResult({ status: 'ok', tokens_per_second: 10 }),
      makeResult({ status: 'ok', tokens_per_second: 20 }),
      makeResult({ status: 'ok', tokens_per_second: null }), // excluded
      makeResult({ status: 'http_5xx', tokens_per_second: 999 }), // excluded — not ok
    ]);
    expect(agg.mean_tokens_per_second).toBeCloseTo(15, 5);
  });

  it('computes p50 + p95 over ok latencies (linear interpolation)', () => {
    const agg = aggregateBakeOffResults([
      makeResult({ status: 'ok', latency_ms: 100 }),
      makeResult({ status: 'ok', latency_ms: 200 }),
      makeResult({ status: 'ok', latency_ms: 300 }),
      makeResult({ status: 'ok', latency_ms: 400 }),
      makeResult({ status: 'ok', latency_ms: 500 }),
    ]);
    // 5 sorted points [100,200,300,400,500].
    // p50: idx = 0.5*4 = 2 → 300
    // p95: idx = 0.95*4 = 3.8 → 400*(1-0.8) + 500*0.8 = 480
    expect(agg.p50_latency_ms).toBeCloseTo(300, 5);
    expect(agg.p95_latency_ms).toBeCloseTo(480, 5);
  });

  it('handles single-element latency sample', () => {
    const agg = aggregateBakeOffResults([makeResult({ status: 'ok', latency_ms: 750 })]);
    expect(agg.p50_latency_ms).toBe(750);
    expect(agg.p95_latency_ms).toBe(750);
  });
});
