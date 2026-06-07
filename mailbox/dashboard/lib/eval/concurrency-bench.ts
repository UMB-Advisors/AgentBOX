// dashboard/lib/eval/concurrency-bench.ts
//
// MBOX-162 spike S1 — multi-account T2 concurrency benchmark (BUILD-LOCAL-ONLY).
//
// Purpose: measures whether a Jetson (T2) can classify+draft for N accounts in
// both `serialized` and `concurrent` scheduling modes without breaching the S1
// gate defined in docs/addendum-mailbox-multi-account-v0_1-2026-05-20.md §6 and
// the DR-45 kill criterion: classify p95 < 5000ms AND peak memory ≤ 4.0 GiB.
//
// The real measurement run executes later on the live M1 appliance in an
// operator-scheduled quiet window. This module is BUILD-LOCAL-ONLY.
//
// Why its own module (vs extending bake-off.ts): the bake-off varies the model
// dimension at fixed prompt/trace envelope. This harness varies the CONCURRENCY
// dimension (N accounts × scheduling mode) at a fixed prompt/model, and adds a
// memory-over-time surface the bake-off does not have (peak memory sampled on
// an injectable interval). The two concerns compose cleanly when separated.
//
// Every external dependency (classify fetch, draft fetch via runBakeOffOnTrace,
// memory sampler, clock, interval timer, timeouts) is INJECTABLE so the unit
// tests (test/lib/concurrency-bench.test.ts) are fully deterministic without
// hitting any network, /proc/meminfo, or real clock.

import { readFileSync } from 'node:fs';
import { type BakeOffPrompt, type ModelEndpoint, runBakeOffOnTrace } from './bake-off';
import type { Trace } from './trace-set';

// ── Constants ──────────────────────────────────────────────────────────

/** addendum §6 / SM-90: classify p95 must be strictly below this ceiling. */
const S1_CLASSIFY_P95_CEILING_MS = 5000;

/**
 * DR-45 T2 envelope: the WORKLOAD-ATTRIBUTABLE peak memory must be at or below
 * this ceiling. We compare the delta (peak sampled used − the t0 baseline), NOT
 * absolute host-used: a live appliance already sits well above 4 GiB with
 * resident services + warm models, so absolute host-used can't map to DR-45's
 * "combined model + KV cache" envelope. The delta isolates what the N-account
 * workload adds on top of baseline. Under the serialized scheduling model
 * (accounts processed one after another, not simultaneously) this delta ≈ a
 * single active request's KV growth and stays small; concurrent mode is where
 * it grows. Caveat: the t0 baseline is sampled at run start — for a true
 * model+KV reading, capture it with the inference engines warm-but-idle (a
 * cold baseline folds the model weights into the delta).
 */
const S1_PEAK_MEM_CEILING_GIB = 4.0;

/** Mirror from memory.ts — kB per GiB. */
const KB_PER_GIB = 1024 * 1024;

/** How often the memory sampler polls /proc/meminfo by default. */
const DEFAULT_MEM_SAMPLE_INTERVAL_MS = 250;

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Opaque handle returned by the injectable interval timer.
 *
 * Environment-agnostic on purpose: under Node `setInterval` returns a
 * `NodeJS.Timeout`, under the DOM lib it returns `number`, and `vi.useFakeTimers()`
 * returns its own shape. Anchoring the deps surface to this alias (rather than the
 * global `typeof setInterval`, whose primary overload returns `number`) lets test
 * mocks line up without casts in either environment.
 */
export type IntervalHandle = ReturnType<typeof setInterval>;

/**
 * Scheduling mode for the N-account run.
 *
 * - `serialized`: each account fully completes (classify+draft for all its
 *   traces) before the next account starts. Serialized through the single
 *   model envelope — the safe T2 mode per DR-45.
 * - `concurrent`: all accounts run in parallel via `Promise.all`. Higher
 *   throughput; riskier on 8 GiB unified RAM (the subject of S1).
 */
export type BenchMode = 'serialized' | 'concurrent';

/**
 * Per-call classify result (Ollama `/api/generate` shape).
 * `status === 'ok'` on success; other values are error tags (e.g.
 * `'http_5xx'`, `'timeout'`, `'fetch_error'`). Never throws — errors land
 * in these fields.
 */
export interface ClassifyResult {
  /** Raw model response text. */
  response: string;
  /** Reported token count (Ollama `eval_count`). May be null if absent. */
  eval_count: number | null;
  /** Wall-clock latency of the classify call in milliseconds. */
  latency_ms: number;
  /** `'ok'` on success; an error tag otherwise. */
  status: 'ok' | string;
  /** Human-readable error, if status !== 'ok'. */
  error: string | null;
}

/**
 * Configuration for one simulated account.
 *
 * The classify and draft endpoints may be shared across accounts (the default
 * in the CLI — same Jetson Ollama/llama.cpp serving all accounts) or distinct
 * (for future per-account model override testing).
 */
export interface AccountConfig {
  /** Logical identifier for the account (e.g. `'acct-0'`). */
  account_id: string;
  /** Endpoint for the classify call (Ollama `/api/generate`). */
  classifyEndpoint: ModelEndpoint;
  /** Endpoint for the draft call (llama.cpp `/v1/chat/completions` via bake-off). */
  draftEndpoint: ModelEndpoint;
  /** Human-readable label for reporting (optional). */
  persona_label?: string;
}

/**
 * All injectable dependencies for `runConcurrencyBench`.
 * Every field defaults to a real implementation — tests override each one
 * to stay deterministic and off-hardware.
 */
export interface ConcurrencyBenchDeps {
  /**
   * Injectable classify function. Default calls Ollama `/api/generate`.
   * Signature mirrors `defaultClassify` exactly so tests can swap in a stub.
   */
  classifyFn?: (
    account: AccountConfig,
    trace: Trace,
    opts: { fetchFn?: typeof fetch; timeoutMs?: number },
  ) => Promise<ClassifyResult>;

  /** Injectable fetch forwarded to `runBakeOffOnTrace` for the draft call. */
  fetchFn?: typeof fetch;

  /**
   * Injectable memory reader. Default reads /proc/meminfo and computes
   * `(MemTotal - MemAvailable) / KB_PER_GIB`. On failure returns 0 — the
   * sampler never throws; a failed sample contributes 0, not a crash.
   */
  readUsedMemGiB?: () => number;

  /** Injectable clock. Default: `Date.now`. */
  now?: () => number;

  /**
   * Injectable interval timer. Defaults to the global `setInterval`.
   * Typed as an environment-agnostic handler/handle pair so test mocks line up
   * without casts. Pass `vi.useFakeTimers()`-compatible `setInterval` in tests.
   */
  setIntervalFn?: (handler: () => void, ms: number) => IntervalHandle;

  /**
   * Injectable interval clearer. Defaults to the global `clearInterval`.
   */
  clearIntervalFn?: (handle: IntervalHandle) => void;

  /** Override the memory-sampler poll interval in ms. Default 250 ms. */
  memSampleIntervalMs?: number;

  /** Per-call classify timeout in ms. Default 60_000. */
  classifyTimeoutMs?: number;

  /** Per-call draft timeout in ms. Default 60_000. */
  draftTimeoutMs?: number;
}

/**
 * Per-account metric output. Aggregates are computed from raw latency arrays.
 */
export interface PerAccountMetrics {
  account_id: string;
  /** Total classify calls made (= trace count). */
  classify_count: number;
  /** Total draft calls made (= trace count). */
  draft_count: number;
  /** p95 classify latency for this account, or null if no data. */
  classify_p95_ms: number | null;
  /** p95 draft latency for this account, or null if no data. */
  draft_p95_ms: number | null;
  /** Raw per-trace classify latencies, in call order. */
  classify_latencies_ms: number[];
  /** Raw per-trace draft latencies, in call order. */
  draft_latencies_ms: number[];
}

/**
 * Full result for one `runConcurrencyBench` invocation.
 */
export interface ConcurrencyBenchResult {
  /** Scheduling mode used. */
  mode: BenchMode;
  /** Number of accounts. */
  account_count: number;
  /** Number of traces run per account. */
  trace_count_per_account: number;
  /** Per-account breakdown. */
  per_account: PerAccountMetrics[];
  /** p95 classify latency across ALL accounts (flattened). */
  overall_classify_p95_ms: number | null;
  /** p95 draft latency across ALL accounts (flattened). */
  overall_draft_p95_ms: number | null;
  /** Absolute peak memory used (GiB) across all sampler observations — host
   *  total (MemTotal − MemAvailable). Kept for context/reporting only. */
  peak_mem_gib: number;
  /** Baseline memory used (GiB) — the t0 sample taken before any classify/draft
   *  call. Subtracted from peak to isolate the workload-attributable footprint. */
  baseline_mem_gib: number;
  /** Workload-attributable peak (GiB): max(0, peak_mem_gib − baseline_mem_gib).
   *  THIS is what the S1 verdict compares against the 4.0 GiB DR-45 ceiling. */
  peak_workload_mem_gib: number;
  /** All raw memory observations taken during the run (GiB). */
  mem_samples_gib: number[];
  /** S1 gate verdict — pass iff classify p95 < 5000ms AND peak *workload* mem ≤ 4.0 GiB. */
  verdict: S1Verdict;
}

/**
 * Discriminated union for the S1 gate verdict.
 *
 * - `{ verdict: 'pass' }` — classify p95 < 5000ms AND peak mem ≤ 4.0 GiB
 *   (addendum §6 / DR-45).
 * - `{ verdict: 'fail', breaches }` — lists every breached dimension.
 */
export type S1Verdict = { verdict: 'pass' } | { verdict: 'fail'; breaches: S1Breach[] };

/**
 * Dimension names for S1 breaches. Each appears at most once per verdict.
 */
export type S1Breach = 'classify_p95' | 'peak_memory';

// ── percentile ────────────────────────────────────────────────────────
//
// Type-7 linear interpolation — identical to the `percentile` in bake-off.ts.
// Re-exported from this module so tests can exercise it directly without
// depending on the bake-off module. (The bake-off copy is not exported.)

/**
 * Compute the q-th quantile of `sortedAsc` using Type-7 linear interpolation
 * (R's default). Returns `null` for an empty array; the single element for a
 * length-1 array.
 *
 * Caller is responsible for sorting; this function does NOT sort in place.
 */
export function percentile(sortedAsc: readonly number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  const first = sortedAsc[0];
  if (sortedAsc.length === 1) return first ?? null;
  const idx = q * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sortedAsc[lo];
  const hiVal = sortedAsc[hi];
  if (loVal === undefined || hiVal === undefined) return null;
  if (lo === hi) return loVal;
  const w = idx - lo;
  return loVal * (1 - w) + hiVal * w;
}

// ── evaluateS1Verdict ─────────────────────────────────────────────────

/**
 * Evaluate the S1 gate (addendum §6 / DR-45) given aggregate metrics.
 *
 * `peakWorkloadMemGiB` is the workload-attributable delta (peak − t0 baseline),
 * NOT absolute host-used — see `S1_PEAK_MEM_CEILING_GIB`.
 *
 * **Boundary semantics (exact):**
 * - `classifyP95Ms >= 5000` → breaches `'classify_p95'` (strict `< 5000` required).
 * - `classifyP95Ms === null` → breaches `'classify_p95'` (cannot prove < 5000).
 * - `peakWorkloadMemGiB > 4.0` → breaches `'peak_memory'` (`<= 4.0` is acceptable).
 * - `peakWorkloadMemGiB === 4.0` → does NOT breach (exactly at ceiling is PASS).
 *
 * Returns `{ verdict: 'pass' }` if and only if no breaches.
 */
export function evaluateS1Verdict(input: {
  classifyP95Ms: number | null;
  peakWorkloadMemGiB: number;
}): S1Verdict {
  const breaches: S1Breach[] = [];

  // classify_p95: null means no data — treat as breach (cannot prove < 5000).
  // Strict < 5000 required: >= 5000 is a failure.
  if (input.classifyP95Ms === null || input.classifyP95Ms >= S1_CLASSIFY_P95_CEILING_MS) {
    breaches.push('classify_p95');
  }

  // peak_memory: workload delta > 4.0 breaches. Exactly 4.0 is acceptable.
  if (input.peakWorkloadMemGiB > S1_PEAK_MEM_CEILING_GIB) {
    breaches.push('peak_memory');
  }

  if (breaches.length === 0) {
    return { verdict: 'pass' };
  }
  return { verdict: 'fail', breaches };
}

// ── defaultReadUsedMemGiB ─────────────────────────────────────────────

/**
 * Default memory-sampler implementation.
 *
 * Reads `/proc/meminfo` and returns `(MemTotal - MemAvailable) / KB_PER_GIB`.
 * On any read/parse failure returns `0` — the sampler contract guarantees it
 * never throws so a failed sample contributes 0, not a crash. Callers interpret
 * 0 conservatively (it's a floor, not a ceiling).
 */
export function defaultReadUsedMemGiB(): number {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const totalMatch = meminfo.match(/^MemTotal:\s+(\d+)\s+kB$/m);
    const availMatch = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (!totalMatch || !availMatch) return 0;
    const totalKb = Number.parseInt(totalMatch[1]!, 10);
    const availKb = Number.parseInt(availMatch[1]!, 10);
    if (!Number.isFinite(totalKb) || !Number.isFinite(availKb)) return 0;
    const usedKb = totalKb - availKb;
    return usedKb < 0 ? 0 : usedKb / KB_PER_GIB;
  } catch {
    return 0;
  }
}

// ── defaultClassify ────────────────────────────────────────────────────

/**
 * Default classify implementation — real fetch to Ollama `/api/generate`.
 *
 * Posts `{ model, prompt, stream: false, options: { temperature: 0 } }` and
 * parses the `{ response, eval_count }` fields. Uses an AbortController
 * timeout (mirrors bake-off.ts `runBakeOffOnTrace`). Never throws — errors
 * are captured in `status` / `error`.
 *
 * The prompt is a minimal inline classify stub assembled from trace fields.
 * The exact text is not what S1 measures; latency and memory pressure are.
 */
async function defaultClassify(
  account: AccountConfig,
  trace: Trace,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number },
): Promise<ClassifyResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const url = `${account.classifyEndpoint.baseUrl.replace(/\/$/, '')}/api/generate`;

  const prompt = [
    `Classify this email into a single category (inquiry, reorder, scheduling, follow_up, internal, escalate, spam_marketing, unknown).`,
    `From: ${trace.inbox_from ?? '(unknown)'}`,
    `Subject: ${trace.inbox_subject ?? '(no subject)'}`,
    `Body: ${trace.inbox_body.slice(0, 1000)}`,
    `Reply with just the category name.`,
  ].join('\n');

  const body = {
    model: account.classifyEndpoint.model,
    prompt,
    stream: false,
    options: { temperature: 0 },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const latency_ms = Date.now() - startedAt;
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        response: '',
        eval_count: null,
        latency_ms,
        status: res.status >= 500 ? 'http_5xx' : 'http_4xx',
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const parsed = (await res.json()) as { response?: unknown; eval_count?: unknown };
    const response = typeof parsed.response === 'string' ? parsed.response : '';
    const eval_count =
      typeof parsed.eval_count === 'number' && Number.isFinite(parsed.eval_count)
        ? parsed.eval_count
        : null;

    return { response, eval_count, latency_ms, status: 'ok', error: null };
  } catch (err) {
    const latency_ms = Date.now() - startedAt;
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    const status = ctrl.signal.aborted ? 'timeout' : 'fetch_error';
    return {
      response: '',
      eval_count: null,
      latency_ms,
      status,
      error: msg.slice(0, 300),
    };
  }
}

// ── buildDraftPrompt ───────────────────────────────────────────────────

/**
 * Build a minimal `BakeOffPrompt` from a trace for the draft call.
 * Temperature 0 for determinism; no RAG or persona context (S1 measures
 * load shape at fixed prompt complexity).
 */
function buildDraftPrompt(trace: Trace): BakeOffPrompt {
  return {
    messages: [
      {
        role: 'system',
        content: [
          'You are a small-business operator drafting replies to inbound email.',
          'Respond ONLY with a JSON object: { "body": "<reply>", "subject": "<optional re: subject>" }',
          'No prose before or after the JSON.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `From: ${trace.inbox_from ?? '(unknown)'}`,
          `Subject: ${trace.inbox_subject ?? '(no subject)'}`,
          '',
          trace.inbox_body,
        ].join('\n'),
      },
    ],
    options: { temperature: 0 },
  };
}

// ── runConcurrencyBench ────────────────────────────────────────────────

/**
 * Run the S1 concurrency benchmark for all `accounts` over `tracesPerAccount`.
 *
 * Each account performs one classify call then one draft call per trace.
 * The same `tracesPerAccount` slice is replicated across every account — S1
 * measures load shape (N simultaneous workloads), not per-account corpus
 * variation.
 *
 * @param accounts      Account configs (one per simulated Gmail identity).
 * @param tracesPerAccount  Trace slice to run for each account.
 * @param mode          `'serialized'` (safe T2 mode) or `'concurrent'` (T3 candidate).
 * @param deps          Injectable dependencies — all default to real implementations.
 */
export async function runConcurrencyBench(
  accounts: AccountConfig[],
  tracesPerAccount: Trace[],
  mode: BenchMode,
  deps: ConcurrencyBenchDeps = {},
): Promise<ConcurrencyBenchResult> {
  const classifyFn = deps.classifyFn ?? defaultClassify;
  const fetchFn = deps.fetchFn;
  const readUsedMemGiB = deps.readUsedMemGiB ?? defaultReadUsedMemGiB;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const memSampleIntervalMs = deps.memSampleIntervalMs ?? DEFAULT_MEM_SAMPLE_INTERVAL_MS;
  const classifyTimeoutMs = deps.classifyTimeoutMs ?? 60_000;
  const draftTimeoutMs = deps.draftTimeoutMs ?? 60_000;

  // ── Memory sampler ────────────────────────────────────────────────────
  // Take one immediate sample at t0 so a zero-interval-advance test still
  // has at least one observation and `peak_mem_gib` is meaningful.
  const memSamples: number[] = [readUsedMemGiB()];
  const intervalHandle = setIntervalFn(() => {
    memSamples.push(readUsedMemGiB());
  }, memSampleIntervalMs);

  // ── Per-account runner ────────────────────────────────────────────────

  const perAccountMetrics: PerAccountMetrics[] = [];

  async function runAccount(account: AccountConfig): Promise<void> {
    const classifyLatencies: number[] = [];
    const draftLatencies: number[] = [];

    for (const trace of tracesPerAccount) {
      // Classify step.
      const classifyResult = await classifyFn(account, trace, {
        fetchFn,
        timeoutMs: classifyTimeoutMs,
      });
      classifyLatencies.push(classifyResult.latency_ms);

      // Draft step — uses runBakeOffOnTrace with injected fetchFn.
      const draftPrompt = buildDraftPrompt(trace);
      const traceFilename = `${account.account_id}-${trace.inbox_message_id}.trace.json`;
      const draftResult = await runBakeOffOnTrace(
        trace,
        traceFilename,
        draftPrompt,
        account.draftEndpoint,
        true, // expect JSON function-call envelope
        { fetchFn, timeoutMs: draftTimeoutMs },
      );
      draftLatencies.push(draftResult.latency_ms);
    }

    // Compute per-account p95s.
    const classifySorted = [...classifyLatencies].sort((a, b) => a - b);
    const draftSorted = [...draftLatencies].sort((a, b) => a - b);

    perAccountMetrics.push({
      account_id: account.account_id,
      classify_count: classifyLatencies.length,
      draft_count: draftLatencies.length,
      classify_p95_ms: percentile(classifySorted, 0.95),
      draft_p95_ms: percentile(draftSorted, 0.95),
      classify_latencies_ms: classifyLatencies,
      draft_latencies_ms: draftLatencies,
    });
  }

  // ── Scheduling modes ──────────────────────────────────────────────────

  if (mode === 'serialized') {
    // Await each account fully before starting the next — safe T2 mode.
    for (const account of accounts) {
      await runAccount(account);
    }
  } else {
    // Concurrent: all accounts race — tests T3 candidate on T2.
    await Promise.all(accounts.map(runAccount));
  }

  // ── Teardown ──────────────────────────────────────────────────────────
  clearIntervalFn(intervalHandle);
  // Final sample after all accounts have settled.
  memSamples.push(readUsedMemGiB());

  // ── Aggregate metrics ─────────────────────────────────────────────────

  // Flatten all classify / draft latencies across accounts.
  const allClassify = perAccountMetrics.flatMap((m) => m.classify_latencies_ms);
  const allDraft = perAccountMetrics.flatMap((m) => m.draft_latencies_ms);

  const overallClassifySorted = [...allClassify].sort((a, b) => a - b);
  const overallDraftSorted = [...allDraft].sort((a, b) => a - b);

  const overall_classify_p95_ms = percentile(overallClassifySorted, 0.95);
  const overall_draft_p95_ms = percentile(overallDraftSorted, 0.95);

  // reduce, not Math.max(...spread): memSamples can hold thousands of entries
  // on a long run, and the spread form risks a call-stack RangeError. Matches
  // the reduce pattern used elsewhere (memory.ts / bake-off.ts).
  const peak_mem_gib = memSamples.reduce((a, b) => Math.max(a, b), 0);
  // memSamples always has ≥1 element (the t0 sample pushed at sampler init), so
  // memSamples[0] is defined at runtime; the `?? 0` only satisfies
  // noUncheckedIndexedAccess — it is not a reachable fallback path.
  const baseline_mem_gib = memSamples[0] ?? 0;
  // Workload-attributable peak: what the N-account run added on top of baseline.
  // This — not absolute host-used — is what the S1 gate compares to 4.0 GiB.
  const peak_workload_mem_gib = Math.max(0, peak_mem_gib - baseline_mem_gib);

  const verdict = evaluateS1Verdict({
    classifyP95Ms: overall_classify_p95_ms,
    peakWorkloadMemGiB: peak_workload_mem_gib,
  });

  return {
    mode,
    account_count: accounts.length,
    trace_count_per_account: tracesPerAccount.length,
    per_account: perAccountMetrics,
    overall_classify_p95_ms,
    overall_draft_p95_ms,
    peak_mem_gib,
    baseline_mem_gib,
    peak_workload_mem_gib,
    mem_samples_gib: memSamples,
    verdict,
  };
}
