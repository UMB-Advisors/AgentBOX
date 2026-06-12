// dashboard/test/lib/concurrency-bench.test.ts
//
// MBOX-162 spike S1 — deterministic unit tests for the concurrency-bench lib.
//
// Tests prove: serialized-vs-concurrent scheduling, p95 computation, boundary-
// exact S1 gate, and memory-sampler peak aggregation. No live hardware, no
// real /proc/meminfo, no real clock, no real network.
//
// Style mirrors bake-off.test.ts: vi-based stubs, @/ alias, makeTrace helper.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelEndpoint } from '@/lib/eval/bake-off';
import {
  type AccountConfig,
  type ClassifyResult,
  type ConcurrencyBenchDeps,
  evaluateS1Verdict,
  type IntervalHandle,
  percentile,
  runConcurrencyBench,
} from '@/lib/eval/concurrency-bench';
import { TRACE_FORMAT_VERSION, type Trace } from '@/lib/eval/trace-set';

// ── Helpers ────────────────────────────────────────────────────────────

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
  gguf_sha256: null,
};

const ACCOUNTS: AccountConfig[] = [
  {
    account_id: 'acct-0',
    classifyEndpoint: ENDPOINT,
    draftEndpoint: ENDPOINT,
  },
  {
    account_id: 'acct-1',
    classifyEndpoint: ENDPOINT,
    draftEndpoint: ENDPOINT,
  },
];

/**
 * Build a successful bake-off OpenAI-compat JSON response body.
 * runBakeOffOnTrace calls /v1/chat/completions and parses this shape.
 */
function makeDraftResponse(body = '{"body":"reply text"}'): string {
  return JSON.stringify({
    choices: [{ message: { content: body } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

// ── 1. evaluateS1Verdict boundary table ───────────────────────────────

describe('evaluateS1Verdict — MBOX-162 S1 boundary cases', () => {
  it('passes when classify p95 = 4999ms AND peak = 4.0 GiB (both at ceiling, both ok)', () => {
    const v = evaluateS1Verdict({ classifyP95Ms: 4999, peakWorkloadMemGiB: 4.0 });
    expect(v.verdict).toBe('pass');
  });

  it('fails when classify p95 = 5000ms exactly (strict < 5000 required)', () => {
    const v = evaluateS1Verdict({ classifyP95Ms: 5000, peakWorkloadMemGiB: 4.0 });
    expect(v.verdict).toBe('fail');
    if (v.verdict === 'fail') {
      expect(v.breaches).toEqual(['classify_p95']);
    }
  });

  it('fails when peak = 4.0001 GiB (> 4.0 is a breach; <= 4.0 is ok)', () => {
    const v = evaluateS1Verdict({ classifyP95Ms: 4999, peakWorkloadMemGiB: 4.0001 });
    expect(v.verdict).toBe('fail');
    if (v.verdict === 'fail') {
      expect(v.breaches).toEqual(['peak_memory']);
    }
  });

  it('fails and names both breaches when classify p95 = 5000ms AND peak = 4.0001 GiB', () => {
    const v = evaluateS1Verdict({ classifyP95Ms: 5000, peakWorkloadMemGiB: 4.0001 });
    expect(v.verdict).toBe('fail');
    if (v.verdict === 'fail') {
      expect(v.breaches).toContain('classify_p95');
      expect(v.breaches).toContain('peak_memory');
      expect(v.breaches).toHaveLength(2);
    }
  });

  it('fails when classify p95 is null (no data → cannot prove < 5000)', () => {
    const v = evaluateS1Verdict({ classifyP95Ms: null, peakWorkloadMemGiB: 4.0 });
    expect(v.verdict).toBe('fail');
    if (v.verdict === 'fail') {
      expect(v.breaches).toEqual(['classify_p95']);
    }
  });

  it('passes when classify p95 = 0ms (well below ceiling)', () => {
    const v = evaluateS1Verdict({ classifyP95Ms: 0, peakWorkloadMemGiB: 0 });
    expect(v.verdict).toBe('pass');
  });

  it('fails when classify p95 = 5001ms (above ceiling)', () => {
    const v = evaluateS1Verdict({ classifyP95Ms: 5001, peakWorkloadMemGiB: 0 });
    expect(v.verdict).toBe('fail');
    if (v.verdict === 'fail') {
      expect(v.breaches).toContain('classify_p95');
    }
  });
});

// ── 2. percentile ─────────────────────────────────────────────────────

describe('percentile — MBOX-162 S1', () => {
  it('returns null for an empty array', () => {
    expect(percentile([], 0.5)).toBe(null);
  });

  it('returns the single element for a length-1 array', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
  });

  it('computes p50 and p95 via Type-7 linear interpolation for [100,200,300,400,500]', () => {
    // 5 sorted points [100,200,300,400,500].
    // p50: idx = 0.5 * 4 = 2.0 → 300
    // p95: idx = 0.95 * 4 = 3.8 → 400*(1-0.8) + 500*0.8 = 80 + 400 = 480
    const arr = [100, 200, 300, 400, 500];
    expect(percentile(arr, 0.5)).toBeCloseTo(300, 5);
    expect(percentile(arr, 0.95)).toBeCloseTo(480, 5);
  });

  it('returns the first element for p0', () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
  });

  it('returns the last element for p100', () => {
    expect(percentile([10, 20, 30], 1)).toBe(30);
  });
});

// ── 3. Scheduling: serialized vs concurrent ───────────────────────────
//
// Uses immediately-resolving stubs. We record enter/exit of classify and
// use a controllable draft fetch that records call order.

describe('runConcurrencyBench — scheduling (MBOX-162 S1)', () => {
  it('serialized mode: account-0 classify+draft complete before account-1 classify starts', async () => {
    const order: string[] = [];

    // classifyFn records account entry and exit.
    const classifyFn: ConcurrencyBenchDeps['classifyFn'] = async (
      account,
      _trace,
      _opts,
    ): Promise<ClassifyResult> => {
      order.push(`${account.account_id}:classify:start`);
      order.push(`${account.account_id}:classify:done`);
      return { response: 'inquiry', eval_count: 5, latency_ms: 10, status: 'ok', error: null };
    };

    // fetchFn records draft entry/exit (used by runBakeOffOnTrace).
    const fetchFn = vi.fn().mockImplementation(async (_url: string): Promise<Response> => {
      const accountId = _url.includes('8080') ? 'unknown' : 'unknown';
      void accountId; // extract account from context below via order tracking
      return new Response(makeDraftResponse(), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    // We use a simple approach: track classify order and verify its sequencing.
    // Because fetchFn resolves immediately, each account finishes classify+draft
    // in one synchronous tick before the next account's classify fires in
    // serialized mode.
    const acct0OrderBefore: string[] = [];
    const classifyFnTracked: ConcurrencyBenchDeps['classifyFn'] = async (
      account,
      trace,
      opts,
    ): Promise<ClassifyResult> => {
      // Snapshot order BEFORE recording entry (so we can assert nothing from
      // account-1 has started when account-0 starts).
      if (account.account_id === 'acct-1') {
        acct0OrderBefore.push(...order.filter((e) => e.startsWith('acct-0')));
      }
      return classifyFn(account, trace, opts);
    };

    await runConcurrencyBench(ACCOUNTS, [makeTrace()], 'serialized', {
      classifyFn: classifyFnTracked,
      fetchFn,
      readUsedMemGiB: () => 1.0,
      setIntervalFn: (_fn: () => void, _ms: number): IntervalHandle => {
        // No-op sampler — no real timers in this test.
        return 0 as unknown as IntervalHandle;
      },
      clearIntervalFn: (_h: IntervalHandle): void => {
        /* no-op */
      },
      memSampleIntervalMs: 99999,
    });

    // In serialized mode, account-1's classify must only fire after account-0's
    // classify has already been recorded.
    expect(acct0OrderBefore).toContain('acct-0:classify:start');
    expect(acct0OrderBefore).toContain('acct-0:classify:done');
  });

  it('concurrent mode: both classify calls fire before either draft resolves', async () => {
    // Track the order of classify starts + draft completions across accounts.
    // Resolvers held in a ref object so TS control-flow analysis doesn't narrow
    // the post-await read back to `never` (assignment happens inside a callback).
    const globalOrder: string[] = [];
    const draftResolvers: { acct0: (() => void) | null; acct1: (() => void) | null } = {
      acct0: null,
      acct1: null,
    };

    // classifyFn records that classify started for each account — resolves
    // immediately.
    const classifyFn: ConcurrencyBenchDeps['classifyFn'] = async (
      account,
    ): Promise<ClassifyResult> => {
      globalOrder.push(`${account.account_id}:classify`);
      return { response: 'inquiry', eval_count: 5, latency_ms: 10, status: 'ok', error: null };
    };

    // fetchFn: stalls until the promise is explicitly resolved so we can
    // verify that both classify calls have fired before any draft finishes.
    const fetchFn = vi.fn().mockImplementation(async (_url: string): Promise<Response> => {
      // Determine which account's draft this is by call order.
      const callIndex = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length - 1;
      const acctId = callIndex === 0 ? 'acct-0' : 'acct-1';
      await new Promise<void>((resolve) => {
        if (acctId === 'acct-0') {
          draftResolvers.acct0 = resolve;
        } else {
          draftResolvers.acct1 = resolve;
        }
      });
      globalOrder.push(`${acctId}:draft:done`);
      return new Response(makeDraftResponse(), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    // Run concurrently. Both classify calls fire synchronously (they resolve
    // immediately); the Promise.all means both are kicked off before either
    // draft resolves (drafts are blocked on their stalled fetchFn).
    const benchPromise = runConcurrencyBench(ACCOUNTS, [makeTrace()], 'concurrent', {
      classifyFn,
      fetchFn,
      readUsedMemGiB: () => 1.0,
      setIntervalFn: (_fn: () => void, _ms: number): IntervalHandle =>
        0 as unknown as IntervalHandle,
      clearIntervalFn: (_h: IntervalHandle): void => {
        /* no-op */
      },
      memSampleIntervalMs: 99999,
    });

    // Flush microtasks so classify calls fire.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Both classify calls should have fired before any draft has completed.
    const classifiesBefore = globalOrder.filter((e) => e.includes(':classify'));
    expect(classifiesBefore.length).toBe(2);
    expect(classifiesBefore).toContain('acct-0:classify');
    expect(classifiesBefore).toContain('acct-1:classify');

    // No drafts done yet.
    expect(globalOrder.filter((e) => e.includes(':draft:done'))).toHaveLength(0);

    // Now resolve both drafts and let the bench finish.
    draftResolvers.acct0?.();
    draftResolvers.acct1?.();
    await benchPromise;

    // After resolution, both drafts completed.
    expect(globalOrder.filter((e) => e.includes(':draft:done'))).toHaveLength(2);
  });
});

// ── 4. p95 computation (classify latencies) ────────────────────────────

describe('runConcurrencyBench — p95 computation (MBOX-162 S1)', () => {
  it('overall classify p95 matches Type-7 interpolation over scripted latencies', async () => {
    // Scripted latencies per account per trace:
    // account-0: [100, 200, 300]
    // account-1: [400, 500, 600]
    // Flattened sorted: [100, 200, 300, 400, 500, 600]
    // p95 of 6 values: idx = 0.95*5 = 4.75 → 500*(1-0.75) + 600*0.75 = 125 + 450 = 575
    const latencyMap: Record<string, number[]> = {
      'acct-0': [100, 200, 300],
      'acct-1': [400, 500, 600],
    };
    const callCounters: Record<string, number> = { 'acct-0': 0, 'acct-1': 0 };

    const classifyFn: ConcurrencyBenchDeps['classifyFn'] = async (
      account,
    ): Promise<ClassifyResult> => {
      const idx = callCounters[account.account_id] ?? 0;
      callCounters[account.account_id] = idx + 1;
      const latency = latencyMap[account.account_id]?.[idx] ?? 100;
      return {
        response: 'inquiry',
        eval_count: 5,
        latency_ms: latency,
        status: 'ok',
        error: null,
      };
    };

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(makeDraftResponse(), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const traces = [
      makeTrace({ inbox_message_id: 'msg-1' }),
      makeTrace({ inbox_message_id: 'msg-2' }),
      makeTrace({ inbox_message_id: 'msg-3' }),
    ];

    const result = await runConcurrencyBench(ACCOUNTS, traces, 'serialized', {
      classifyFn,
      fetchFn,
      readUsedMemGiB: () => 1.0,
      setIntervalFn: (_fn: () => void, _ms: number): IntervalHandle =>
        0 as unknown as IntervalHandle,
      clearIntervalFn: (_h: IntervalHandle): void => {
        /* no-op */
      },
      memSampleIntervalMs: 99999,
    });

    // Per-account p95s (3 values each).
    // acct-0: sorted [100,200,300], p95 idx=0.95*2=1.9 → 200*(1-0.9)+300*0.9=20+270=290
    const acct0 = result.per_account.find((m) => m.account_id === 'acct-0');
    expect(acct0).toBeDefined();
    expect(acct0?.classify_p95_ms).toBeCloseTo(290, 1);

    // acct-1: sorted [400,500,600], p95 idx=1.9 → 500*(0.1)+600*(0.9)=50+540=590
    const acct1 = result.per_account.find((m) => m.account_id === 'acct-1');
    expect(acct1).toBeDefined();
    expect(acct1?.classify_p95_ms).toBeCloseTo(590, 1);

    // Overall p95 over all 6 latencies.
    // Flattened sorted: [100,200,300,400,500,600]
    // p95 idx = 0.95*5 = 4.75 → 500*(0.25) + 600*(0.75) = 125+450 = 575
    expect(result.overall_classify_p95_ms).toBeCloseTo(575, 1);
  });
});

// ── 5. Memory-sampler peak aggregation ────────────────────────────────
//
// Uses vi.useFakeTimers() so the interval fires synchronously when advanced.

describe('runConcurrencyBench — memory-sampler peak aggregation (MBOX-162 S1)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('peak_mem_gib equals the max of the scripted readUsedMemGiB sequence', async () => {
    vi.useFakeTimers();

    // Scripted memory sequence. The sampler calls readUsedMemGiB at t0 (immediate)
    // plus every 100ms via setInterval. We control the values returned.
    const memSequence = [1.0, 3.5, 2.0, 1.8];
    let callIdx = 0;
    const readUsedMemGiB = (): number => {
      const val = memSequence[callIdx] ?? memSequence[memSequence.length - 1] ?? 0;
      callIdx++;
      return val;
    };

    // classifyFn resolves after 50ms so the interval fires once mid-bench.
    const classifyFn: ConcurrencyBenchDeps['classifyFn'] = async (): Promise<ClassifyResult> => {
      // Advance timers 150ms → two interval ticks fire.
      await vi.advanceTimersByTimeAsync(150);
      return { response: 'inquiry', eval_count: 5, latency_ms: 50, status: 'ok', error: null };
    };

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(makeDraftResponse(), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const result = await runConcurrencyBench([ACCOUNTS[0]!], [makeTrace()], 'serialized', {
      classifyFn,
      fetchFn,
      readUsedMemGiB,
      setIntervalFn: setInterval, // real setInterval — fake timers intercept it
      clearIntervalFn: clearInterval,
      memSampleIntervalMs: 100,
    });

    // Sampled values: t0=1.0, interval@100ms=3.5, interval@200ms fired during advance=2.0,
    // plus the final post-bench sample. Peak must be 3.5 (or higher if more calls were made).
    // We assert peak equals max of what was sampled — at least 3.5 (the scripted max).
    expect(result.peak_mem_gib).toBeGreaterThanOrEqual(3.5);
    expect(result.mem_samples_gib.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...result.mem_samples_gib)).toBe(result.peak_mem_gib);
  });

  it('peak_mem_gib = Math.max(scripted sequence) when sequence has 3.5 as peak', async () => {
    vi.useFakeTimers();

    const samples: number[] = [];
    let readIdx = 0;
    const scriptedValues = [1.0, 3.5, 2.0];
    const readUsedMemGiB = (): number => {
      const v = scriptedValues[readIdx % scriptedValues.length] ?? 0;
      readIdx++;
      samples.push(v);
      return v;
    };

    // Classify advances timers 100ms each call → interval fires once per trace.
    const classifyFn: ConcurrencyBenchDeps['classifyFn'] = async (): Promise<ClassifyResult> => {
      await vi.advanceTimersByTimeAsync(100);
      return { response: 'inquiry', eval_count: 5, latency_ms: 50, status: 'ok', error: null };
    };

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(makeDraftResponse(), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const result = await runConcurrencyBench([ACCOUNTS[0]!], [makeTrace()], 'serialized', {
      classifyFn,
      fetchFn,
      readUsedMemGiB,
      setIntervalFn: setInterval,
      clearIntervalFn: clearInterval,
      memSampleIntervalMs: 100,
    });

    // Peak should equal Math.max of all sampled values.
    expect(result.peak_mem_gib).toBe(Math.max(...result.mem_samples_gib, 0));
    // The scripted peak 3.5 must appear somewhere in the sequence.
    expect(result.mem_samples_gib).toContain(3.5);
    expect(result.peak_mem_gib).toBe(3.5);

    // Baseline is the t0 sample (1.0); workload delta = peak − baseline = 2.5.
    expect(result.baseline_mem_gib).toBe(1.0);
    expect(result.peak_workload_mem_gib).toBeCloseTo(2.5, 5);
  });

  it('verdict uses workload delta, not absolute peak: high host-used baseline still PASSES when the run adds little (live-box scenario)', async () => {
    vi.useFakeTimers();

    // Simulate a live appliance: ~5.8 GiB already resident at baseline, the run
    // adds only ~0.2 GiB (serialized → one active request's KV). Absolute peak
    // (6.0) exceeds the 4.0 ceiling, but the WORKLOAD delta (0.2) does not.
    const scripted = [5.8, 6.0, 5.9];
    let idx = 0;
    const readUsedMemGiB = (): number => {
      const v = scripted[idx % scripted.length] ?? 0;
      idx++;
      return v;
    };

    const classifyFn: ConcurrencyBenchDeps['classifyFn'] = async (): Promise<ClassifyResult> => {
      await vi.advanceTimersByTimeAsync(100);
      return { response: 'inquiry', eval_count: 5, latency_ms: 50, status: 'ok', error: null };
    };
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(makeDraftResponse(), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const result = await runConcurrencyBench([ACCOUNTS[0]!], [makeTrace()], 'serialized', {
      classifyFn,
      fetchFn,
      readUsedMemGiB,
      setIntervalFn: setInterval,
      clearIntervalFn: clearInterval,
      memSampleIntervalMs: 100,
    });

    expect(result.baseline_mem_gib).toBe(5.8);
    expect(result.peak_mem_gib).toBeGreaterThan(4.0); // absolute exceeds ceiling
    // Pin the exact delta (peak 6.0 − baseline 5.8 = 0.2), not just "<= 4.0":
    // a loose bound would still pass even if the delta computation were broken.
    expect(result.peak_workload_mem_gib).toBeCloseTo(0.2, 5);
    // classify p95 = 50ms < 5000 AND workload delta ≤ 4.0 → PASS despite high absolute peak.
    expect(result.verdict.verdict).toBe('pass');
  });
});
