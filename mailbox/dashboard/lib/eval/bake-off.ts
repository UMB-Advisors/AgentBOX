// dashboard/lib/eval/bake-off.ts
//
// STAQPRO-342 — three-way T2 model bake-off (Nemotron 4B vs Qwen3.5-4B vs
// Gemma 4 E4B). Pure-TS loop over `Trace[]`: for each trace, calls a
// llama.cpp HTTP endpoint with an assembled chat prompt, captures per-trace
// metrics, and emits a structured `BakeOffPerTraceResult`. Aggregation +
// run-level provenance is also in this module.
//
// Why this is its own module (vs an extension of `rag-eval-harness.ts`):
// the harness varies the RAG dimension at fixed model; this varies the
// model dimension at fixed prompt envelope. Cross-architecture comparison
// (Mamba vs PLE vs transformer) and llama.cpp-served Q4_K_M variants need
// a different metric surface (peak memory, function-call validity, t/s)
// than the cosine-vs-judge surface of rag-eval-harness.
//
// Prompt envelope: INJECTED, not hardcoded. The CLI (bake-off-harness.ts)
// is responsible for snapshotting the current production drafter prompt at
// bake-off time into a frozen `assemblePrompt(trace) -> BakeOffPrompt`
// function. That snapshot's git SHA is recorded in run provenance so a
// re-run six months later reproduces the same prompt → response mapping
// (modulo model nondeterminism).
//
// Privacy: same posture as `rag-eval-harness.ts`. Per-trace JSONL outputs
// contain PII-scrubbed reply bodies and the model's outputs; they are
// gitignored under `dashboard/eval/results/`.

import type { Trace } from './trace-set';

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Chat message in the Ollama-shape envelope the dashboard's
 * `/api/internal/llm/api/chat` proxy accepts. Same shape llama.cpp's
 * `/v1/chat/completions` endpoint accepts.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/**
 * A frozen prompt envelope for one trace. Assembled outside the lib so the
 * lib stays prompt-agnostic; harness CLI is responsible for the assembly.
 */
export interface BakeOffPrompt {
  /** Chat messages to send. Includes the system prompt at messages[0]. */
  messages: ChatMessage[];
  /**
   * Model-side options (temperature, top_p, num_predict). Mirrors Ollama
   * `options` field. Pinned per-run so candidates are scored under
   * identical decoding settings.
   */
  options: {
    temperature: number;
    top_p?: number;
    num_predict?: number;
    seed?: number;
  };
}

/**
 * Identifies which model the harness is currently hitting + where it's
 * served. The model tag is what's sent over the wire; the digest/sha is
 * captured separately for provenance (llama.cpp doesn't echo it back, so
 * the operator records it at bake-off time).
 */
export interface ModelEndpoint {
  /** Model tag (e.g., `nemotron-3-nano-4b-Q4_K_M.gguf`). */
  model: string;
  /** Base URL of the llama.cpp server (e.g., `http://192.168.50.179:8080`). */
  baseUrl: string;
  /** Quantization tag (e.g., `Q4_K_M`). For provenance/report; not over the wire. */
  quantization: string;
  /** Context length the server was started with (provenance). */
  context_length: number;
  /** llama.cpp git SHA at server start (provenance; operator captures and passes in). */
  runtime_sha: string;
  /** SHA-256 of the GGUF on disk at bake-off time (provenance). */
  gguf_sha256: string | null;
}

/**
 * Per-trace result captured by `runBakeOffOnTrace`. One JSONL line per
 * result. Fields are flat so the operator can `jq` over the file without
 * navigating nested structures.
 */
export interface BakeOffPerTraceResult {
  // ── trace identity ────────────────────────────────────────────────
  trace_filename: string;
  inbox_message_id: string;
  classification: string | null;
  workflow_category: Trace['workflow_category'];

  // ── model identity (denormalized from ModelEndpoint for grep-ability) ─
  model: string;
  quantization: string;
  context_length: number;
  runtime_sha: string;

  // ── output ─────────────────────────────────────────────────────────
  /** Raw model output text. May be empty if the call errored. */
  output: string;
  /** Whether the output is well-formed for the requested function-call
   *  envelope (if any). `null` when the prompt didn't request a function
   *  call (free-text drafting). */
  function_call_valid: boolean | null;

  // ── perf metrics ───────────────────────────────────────────────────
  latency_ms: number;
  /** Prompt tokens reported by llama.cpp `timings.prompt_n` (or null). */
  tokens_in: number | null;
  /** Predicted tokens reported by llama.cpp `timings.predicted_n` (or null). */
  tokens_out: number | null;
  /** Output throughput: tokens_out / (predicted_ms / 1000). */
  tokens_per_second: number | null;

  // ── status ─────────────────────────────────────────────────────────
  /** `'ok'` on success; an error tag (e.g., `'http_5xx'`, `'timeout'`,
   *  `'parse_error'`) otherwise. */
  status: 'ok' | string;
  /** Human-readable error string, if status !== 'ok'. */
  error: string | null;
}

/**
 * Run-level provenance carried in the per-run manifest. Mirrors the spirit
 * of `TraceProvenance` in `trace-set.ts`: enough metadata for an operator
 * to audit a result file back to its inputs.
 */
export interface BakeOffRunProvenance {
  /** ISO-8601 timestamp the run started. */
  started_at: string;
  /** ISO-8601 timestamp the run finished (or last result recorded). */
  finished_at: string | null;
  /** Run tag (e.g., `eval-nemotron-3-nano-4b-2026-05-16`). */
  run_tag: string;
  /** Trace-set directory the run sourced from (relative or absolute). */
  trace_set_dir: string;
  /** Trace-set manifest SHA — pinned at load time, captured here for replay. */
  trace_set_manifest_sha256: string;
  /** Model endpoint config used for the whole run. */
  endpoint: ModelEndpoint;
  /** Prompt-assembly git SHA. Operator passes this in; mirrors the
   *  bake-off-prompt snapshot in `dashboard/lib/eval/bake-off-prompt.ts`. */
  prompt_assembly_sha: string;
  /** Total traces attempted in this run. */
  trace_count: number;
  /** Traces with status === 'ok'. */
  ok_count: number;
  /** Traces with status !== 'ok'. */
  error_count: number;
}

/**
 * Aggregate metric surface, computable from a `BakeOffPerTraceResult[]`.
 * Matches the §5.8 metric requirements in the 342 issue body.
 */
export interface BakeOffAggregates {
  /** Of all ok-status traces with a non-null `function_call_valid`,
   *  the fraction that were valid. `null` when no traces requested
   *  a function call. */
  function_call_success_rate: number | null;
  /** Mean tokens/s across all ok-status traces. `null` if no t/s data. */
  mean_tokens_per_second: number | null;
  /** p50 latency in milliseconds across all ok-status traces. */
  p50_latency_ms: number | null;
  /** p95 latency in milliseconds across all ok-status traces. */
  p95_latency_ms: number | null;
  /** Of `trace_count`, the fraction that returned without status-error. */
  ok_rate: number;
}

// ── Function-call validity check ───────────────────────────────────────

/**
 * Lightweight check: is `output` parseable as a JSON object with the
 * structure the production drafter expects? Today the drafter requests
 * a JSON envelope with `body` (string) and optional `subject` (string).
 *
 * Returns:
 *   - `true`  → parseable JSON object with at least a `body: string` field
 *   - `false` → parse error, non-object, or missing required field
 *   - `null`  → caller marked this as a free-text trace (no function-call
 *               envelope expected)
 *
 * Note: this is intentionally not a zod schema — the bake-off needs to
 * judge how well a model conforms to the loosest reasonable structural
 * contract, not whether it nails a strict schema. Strict schema scoring
 * happens at the addendum-v0.2 / DR-21 deliverable stage.
 */
export function checkFunctionCallValid(
  output: string,
  expectFunctionCall: boolean,
): boolean | null {
  if (!expectFunctionCall) return null;
  if (!output || output.trim() === '') return false;
  let parsed: unknown;
  try {
    // Try direct parse first.
    parsed = JSON.parse(output);
  } catch {
    // Fallback: strip leading/trailing prose around a JSON block. Lazy
    // quantifier so multi-block output (e.g. `{"body":"x"} junk {"y":1}`)
    // matches the FIRST balanced-ish block instead of spanning to the last
    // `}` and failing JSON.parse on the trailing garbage (MBOX-113).
    const m = output.match(/\{[\s\S]*?\}/);
    if (!m) return false;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;
  return typeof obj.body === 'string' && obj.body.length > 0;
}

// ── Per-trace runner ───────────────────────────────────────────────────

export interface RunBakeOffOnTraceDeps {
  /** Injectable fetch for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Per-call timeout in ms. Default 60_000 (matches production drafter
   *  cloud SLO of < 60s; local should be well under). */
  timeoutMs?: number;
}

/**
 * Run one trace through the model. Returns a `BakeOffPerTraceResult` —
 * never throws (errors are captured in `status` + `error`). The caller is
 * responsible for appending the result to the run JSONL.
 */
export async function runBakeOffOnTrace(
  trace: Trace,
  filename: string,
  prompt: BakeOffPrompt,
  endpoint: ModelEndpoint,
  expectFunctionCall: boolean,
  deps: RunBakeOffOnTraceDeps = {},
): Promise<BakeOffPerTraceResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 60_000;

  const baseResult = {
    trace_filename: filename,
    inbox_message_id: trace.inbox_message_id,
    classification: trace.classification,
    workflow_category: trace.workflow_category,
    model: endpoint.model,
    quantization: endpoint.quantization,
    context_length: endpoint.context_length,
    runtime_sha: endpoint.runtime_sha,
  };

  // ── Build the OpenAI-shape body llama.cpp's /v1/chat/completions accepts.
  // This matches `chatRequestToLlamaCpp` in `lib/llm/llamacpp-client.ts` so
  // the harness exercises the same wire format the production drafter uses.
  const body = {
    model: endpoint.model,
    messages: prompt.messages,
    stream: false,
    temperature: prompt.options.temperature,
    ...(prompt.options.top_p !== undefined ? { top_p: prompt.options.top_p } : {}),
    ...(prompt.options.num_predict !== undefined ? { max_tokens: prompt.options.num_predict } : {}),
    ...(prompt.options.seed !== undefined ? { seed: prompt.options.seed } : {}),
  };

  const url = `${endpoint.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

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
        ...baseResult,
        output: '',
        function_call_valid: expectFunctionCall ? false : null,
        latency_ms,
        tokens_in: null,
        tokens_out: null,
        tokens_per_second: null,
        status: res.status >= 500 ? 'http_5xx' : 'http_4xx',
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const parsed = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      timings?: { prompt_n?: number; predicted_n?: number; predicted_ms?: number };
    };

    const output = parsed.choices?.[0]?.message?.content ?? '';
    const usage = parsed.usage ?? {};
    const timings = parsed.timings ?? {};

    // llama.cpp's OpenAI-compat endpoint sometimes returns `timings`,
    // sometimes only `usage`. Coalesce.
    const tokens_in = readNum(timings.prompt_n) ?? readNum(usage.prompt_tokens);
    const tokens_out = readNum(timings.predicted_n) ?? readNum(usage.completion_tokens);
    const predicted_ms = readNum(timings.predicted_ms);
    const tokens_per_second =
      tokens_out !== null && predicted_ms !== null && predicted_ms > 0
        ? tokens_out / (predicted_ms / 1000)
        : null;

    return {
      ...baseResult,
      output,
      function_call_valid: checkFunctionCallValid(output, expectFunctionCall),
      latency_ms,
      tokens_in,
      tokens_out,
      tokens_per_second,
      status: 'ok',
      error: null,
    };
  } catch (err) {
    const latency_ms = Date.now() - startedAt;
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    const status = ctrl.signal.aborted ? 'timeout' : 'fetch_error';
    return {
      ...baseResult,
      output: '',
      function_call_valid: expectFunctionCall ? false : null,
      latency_ms,
      tokens_in: null,
      tokens_out: null,
      tokens_per_second: null,
      status,
      error: msg.slice(0, 300),
    };
  }
}

function readNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ── Aggregator ─────────────────────────────────────────────────────────

/**
 * Compute aggregate metrics from a list of per-trace results. Pure; no I/O.
 */
export function aggregateBakeOffResults(
  results: readonly BakeOffPerTraceResult[],
): BakeOffAggregates {
  const oks = results.filter((r) => r.status === 'ok');
  const okRate = results.length === 0 ? 0 : oks.length / results.length;

  // Function-call success rate: only over oks where function_call_valid !== null.
  const fcEligible = oks.filter((r) => r.function_call_valid !== null);
  const fcSuccessRate =
    fcEligible.length === 0
      ? null
      : fcEligible.filter((r) => r.function_call_valid === true).length / fcEligible.length;

  // Mean t/s over oks with t/s data.
  const tps = oks.map((r) => r.tokens_per_second).filter((v): v is number => v !== null);
  const meanTps = tps.length === 0 ? null : tps.reduce((a, b) => a + b, 0) / tps.length;

  // Latency percentiles over oks.
  const lats = oks.map((r) => r.latency_ms).sort((a, b) => a - b);
  const p50 = percentile(lats, 0.5);
  const p95 = percentile(lats, 0.95);

  return {
    function_call_success_rate: fcSuccessRate,
    mean_tokens_per_second: meanTps,
    p50_latency_ms: p50,
    p95_latency_ms: p95,
    ok_rate: okRate,
  };
}

function percentile(sortedAsc: readonly number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  const first = sortedAsc[0];
  if (sortedAsc.length === 1) return first ?? null;
  // Linear interpolation between closest ranks (Type 7, R's default).
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
