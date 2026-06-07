// dashboard/scripts/rag-eval-harness.ts
//
// STAQPRO-198 — RAG eval harness. Cosine-similarity-based offline A/B for
// "is RAG helping?" against the customer-#1 backfilled corpus (441 inbound,
// reply pairs in mailbox.sent_history with source = 'backfill').
//
// Methodology (locked in the issue):
//
//   For each (inbound, actual_reply) pair:
//     1. Assemble the live drafter's prompt for the inbound (same primitives
//        the /api/internal/draft-prompt route uses — RAG retrieval included
//        when RAG_DISABLED is unset, skipped when RAG_DISABLED=1).
//     2. POST that prompt to Ollama /api/chat with model qwen3:4b-ctx4k.
//     3. Embed both the generated draft and the actual reply via
//        nomic-embed-text:v1.5 (lib/rag/embed.ts).
//     4. Compute cosine similarity (raw dot product — nomic vectors are
//        unit-normalized).
//
// Mode is set by the operator via env, NOT by a CLI flag:
//
//     # baseline (no RAG, persona-stub only)
//     RAG_DISABLED=1 npm run eval:rag -- --limit 50
//     # treatment (with RAG)
//     npm run eval:rag -- --limit 50
//
// Output: dashboard/eval-results/rag-eval-<ISO-timestamp>-<mode>.json plus
// a summary table to stdout. The directory is gitignored — eval JSON is
// per-run customer data.
//
// Why we import the prompt primitives directly instead of POSTing to the
// /api/internal/draft-prompt route: the route requires a mailbox.drafts row
// keyed on draft_id, but backfilled inbounds in inbox_messages have no
// matching draft row. Inserting synthetic drafts to drive the route would
// pollute the live queue. Importing assemblePrompt + retrieveForDraft +
// pickEndpoint + getPersonaContext gives byte-identical assembly without
// the synthetic-draft pollution.
//
// Failure mode: per-pair try/catch — a single Ollama / embed failure logs
// the pair's message_id and continues. Final JSON has a per-pair status
// field so the operator can see which rows dropped out.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Pool } from 'pg';
import type { Category } from '../lib/classification/prompt';
import {
  callJudge,
  type JudgeProvider,
  type JudgeResult,
  type JudgeScores,
  judgeScoreSum,
} from '../lib/drafting/judge';
import { getPersonaContext } from '../lib/drafting/persona';
import { assemblePrompt } from '../lib/drafting/prompt';
import { pickEndpoint } from '../lib/drafting/router';
// STAQPRO-340 — trace-set loader (offline replacement for the DB-driven path)
import {
  type Trace,
  traceManifestSchema,
  traceSchema,
  verifyManifest,
} from '../lib/eval/trace-set';
import { embedText } from '../lib/rag/embed';
import { type RetrievalResult, retrieveForDraft } from '../lib/rag/retrieve';

// =============================================================================
// Pure helpers (unit-tested in test/lib/rag-eval-harness.test.ts)
// =============================================================================

/**
 * Cosine similarity for two equal-length numeric vectors.
 *
 * nomic-embed-text:v1.5 emits unit-normalized 768-dim vectors so dot product
 * equals cosine similarity. We still divide by the magnitude product to be
 * robust against ingested vectors that may have lost normalization through
 * upstream serialization (defensive — sub-microsecond cost on 768 dims).
 *
 * Returns 0 for mismatched lengths or zero-magnitude inputs (rather than
 * NaN) so the aggregator math stays sane.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Sample-selection SQL. JOIN sent_history → inbox_messages on the live
 * foreign-key (sent_history.inbox_message_id = inbox_messages.id), filter
 * to backfilled rows (source = 'backfill'), drop pairs missing either body.
 *
 * The issue spec called for `sh.in_reply_to = im.rfc822_message_id` "or
 * equivalent — confirm during research". Research found:
 *   - sent_history has no in_reply_to / rfc822_message_id columns.
 *   - inbox_messages has in_reply_to + message_id (Gmail msg id).
 *   - The backfill orchestrator (lib/onboarding/gmail-history-backfill.ts)
 *     wires sent_history.inbox_message_id directly to the inbound row's
 *     numeric id. That's the canonical pairing — no header chase needed.
 *
 * limitClause is null for `--limit all`; otherwise `LIMIT N`.
 */
export function buildSampleSql(limitClause: number | null): string {
  const limitFragment = limitClause === null ? '' : `LIMIT ${Math.max(1, Math.floor(limitClause))}`;
  // Order by sent_at so successive runs hit the same prefix when --limit < total.
  return `
    SELECT
      sh.id                          AS sent_history_id,
      sh.message_id                  AS sent_message_id,
      sh.draft_sent                  AS actual_reply_body,
      sh.sent_at                     AS reply_sent_at,
      im.id                          AS inbox_id,
      im.message_id                  AS inbox_message_id,
      im.from_addr                   AS inbox_from,
      im.subject                     AS inbox_subject,
      im.body                        AS inbox_body,
      im.classification              AS inbox_classification,
      im.confidence                  AS inbox_confidence,
      im.thread_id                   AS inbox_thread_id
    FROM mailbox.sent_history sh
    JOIN mailbox.inbox_messages im ON im.id = sh.inbox_message_id
    WHERE sh.source = 'backfill'
      AND sh.inbox_message_id IS NOT NULL
      AND COALESCE(sh.draft_sent, '') <> ''
      AND COALESCE(im.body, '') <> ''
    ORDER BY sh.sent_at ASC
    ${limitFragment}
  `;
}

export interface PerPairScore {
  sent_history_id: number;
  inbox_message_id: string;
  classification: string | null;
  cosine: number | null;
  rag_refs_count: number;
  rag_reason: RetrievalResult['reason'];
  draft_chars: number;
  actual_chars: number;
  status: 'ok' | 'draft_failed' | 'embed_failed' | 'error' | 'judge_only';
  error?: string;
  // STAQPRO-220 — judge fields. Populated only when --judge / --judge-only
  // is on; absent on cosine-only runs so existing eval JSON shape is
  // unchanged when the harness is invoked the same way as before.
  judge_provider?: JudgeProvider;
  judge_status?: JudgeResult['status'];
  judge_score?: number;
  judge_voice?: number;
  judge_facts?: number;
  judge_length?: number;
  judge_rationale?: string;
  judge_error?: string;
  // STAQPRO-340 — per-pair perf metrics. Populated from the Ollama /api/chat
  // response (`prompt_eval_count`, `eval_count`, `eval_duration` in ns).
  // Absent on draft_failed pairs (no metrics to capture). The model-bake-off
  // (STAQPRO-342) aggregates these to enforce the DR-21 ≥ 15 t/s gate.
  latency_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  tokens_per_second?: number;
}

export interface AggregateStats {
  count: number;
  mean: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
}

export interface RagEvalReport {
  generated_at: string;
  mode: 'with-rag' | 'no-rag';
  drafter_model: string;
  embed_model: string;
  sample_size_requested: number | 'all';
  sample_size_actual: number;
  // STAQPRO-340 — run tag for the bake-off `eval-{model}-{date}` convention.
  // Populated from `--run-tag` or derived in main(). Used for the output
  // filename + cross-referencing the run in the addendum.
  run_tag: string;
  // STAQPRO-340 — trace-set provenance. Present when the run sourced its
  // pairs from a committed trace set rather than the live DB. Lets a reader
  // verify the run was executed against a known-good corpus.
  trace_set?: TraceSetProvenance;
  // STAQPRO-340 — perf aggregates. Each is over the subset of pairs that
  // captured the metric (Ollama-shape responses on the local route). Empty
  // aggregates (count=0) when the run had no metrics.
  latency_ms_aggregates?: AggregateStats;
  tokens_in_aggregates?: AggregateStats;
  tokens_out_aggregates?: AggregateStats;
  tokens_per_second_aggregates?: AggregateStats;
  aggregates_global: AggregateStats;
  aggregates_by_category: Record<string, AggregateStats>;
  // STAQPRO-220 — judge aggregates. Present only when judge was enabled.
  // Mirrors the cosine block; aggregated over per-pair judge_score values.
  judge_provider?: JudgeProvider;
  judge_aggregates_global?: AggregateStats;
  judge_aggregates_by_category?: Record<string, AggregateStats>;
  per_pair: PerPairScore[];
  // Counts of pair statuses so an operator can spot drift between modes
  // (e.g., draft_failed exploding under no-rag when local drafts hallucinate
  // empty completions because they have no anchor).
  // `judge_failed` (STAQPRO-220) counts pairs where the judge call or parse
  // failed — judge outages should not poison the cosine aggregate.
  // `judge_rate_limited` (STAQPRO-224) is a strict subset of judge_failed —
  // pairs where the judge returned HTTP 429. Split out so the operator can
  // distinguish "Anthropic throttled us" (rerun at lower --limit or raise
  // JUDGE_RATE_LIMIT_MS) from "judge call is structurally broken" (key
  // missing, malformed response, etc).
  status_counts: Record<PerPairScore['status'], number> & {
    judge_failed: number;
    judge_rate_limited: number;
  };
}

/**
 * Aggregate stats over a list of cosine scores. Excludes nulls (failed
 * pairs). Returns zeros if the input is empty so the JSON shape is stable
 * regardless of corpus state.
 */
export function aggregate(scores: readonly number[]): AggregateStats {
  const xs = scores
    .filter((s) => Number.isFinite(s))
    .slice()
    .sort((a, b) => a - b);
  if (xs.length === 0) {
    return { count: 0, mean: 0, median: 0, p25: 0, p75: 0, min: 0, max: 0 };
  }
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    count: xs.length,
    mean: sum / xs.length,
    median: percentile(xs, 0.5),
    p25: percentile(xs, 0.25),
    p75: percentile(xs, 0.75),
    min: xs[0],
    max: xs[xs.length - 1],
  };
}

// Linear-interpolation percentile (R-7 / Excel default). Caller passes
// already-sorted ascending input.
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * STAQPRO-340 — trace-set provenance carried onto every report that sourced
 * its pairs from a committed trace set. Lets a reader verify a result was
 * generated against a known SHA-256-pinned corpus.
 */
export interface TraceSetProvenance {
  dir: string;
  set_version: string;
  set_sha256: string;
  source_appliance: string;
  count: number;
}

export function buildReport(args: {
  mode: 'with-rag' | 'no-rag';
  drafter_model: string;
  embed_model: string;
  sample_size_requested: number | 'all';
  per_pair: PerPairScore[];
  judge_provider?: JudgeProvider;
  // STAQPRO-340 — new optional inputs. Existing callers (tests) keep the
  // same shape; both fields are optional so the report shape regression-tests
  // unchanged when omitted.
  run_tag?: string;
  trace_set?: TraceSetProvenance;
}): RagEvalReport {
  const {
    mode,
    drafter_model,
    embed_model,
    sample_size_requested,
    per_pair,
    judge_provider,
    run_tag,
    trace_set,
  } = args;
  const okScores = per_pair.filter((p) => p.cosine !== null).map((p) => p.cosine as number);
  const byCategory = new Map<string, number[]>();
  for (const pair of per_pair) {
    if (pair.cosine === null) continue;
    const cat = pair.classification ?? 'unclassified';
    let bucket = byCategory.get(cat);
    if (!bucket) {
      bucket = [];
      byCategory.set(cat, bucket);
    }
    bucket.push(pair.cosine);
  }
  const aggregates_by_category: Record<string, AggregateStats> = {};
  for (const [cat, scores] of byCategory) {
    aggregates_by_category[cat] = aggregate(scores);
  }

  // Judge aggregates — only computed when judge_provider is supplied AND
  // at least one pair carries an `ok` judge_status. The aggregator filters
  // on judge_status === 'ok' so parse_failed / call_failed don't pollute
  // the judge-score distribution.
  let judge_aggregates_global: AggregateStats | undefined;
  let judge_aggregates_by_category: Record<string, AggregateStats> | undefined;
  if (judge_provider) {
    const okJudge = per_pair
      .filter((p) => p.judge_status === 'ok' && typeof p.judge_score === 'number')
      .map((p) => p.judge_score as number);
    judge_aggregates_global = aggregate(okJudge);
    const judgeByCategory = new Map<string, number[]>();
    for (const pair of per_pair) {
      if (pair.judge_status !== 'ok' || typeof pair.judge_score !== 'number') continue;
      const cat = pair.classification ?? 'unclassified';
      let bucket = judgeByCategory.get(cat);
      if (!bucket) {
        bucket = [];
        judgeByCategory.set(cat, bucket);
      }
      bucket.push(pair.judge_score);
    }
    judge_aggregates_by_category = {};
    for (const [cat, scores] of judgeByCategory) {
      judge_aggregates_by_category[cat] = aggregate(scores);
    }
  }

  const status_counts: RagEvalReport['status_counts'] = {
    ok: 0,
    draft_failed: 0,
    embed_failed: 0,
    error: 0,
    judge_only: 0,
    judge_failed: 0,
    judge_rate_limited: 0,
  };
  for (const p of per_pair) {
    status_counts[p.status] += 1;
    // judge_failed mirrors `embed_failed` semantically — count pairs whose
    // judge attempt produced anything other than `ok`. Pairs without any
    // judge attempt (cosine-only run) are not counted.
    if (p.judge_status && p.judge_status !== 'ok') status_counts.judge_failed += 1;
    // STAQPRO-224 — rate_limited is a strict subset of judge_failed; both
    // increment for the same pair so the operator can read
    // judge_failed - judge_rate_limited = "other call/parse failures".
    if (p.judge_status === 'rate_limited') status_counts.judge_rate_limited += 1;
  }

  // STAQPRO-340 — perf aggregates. Each is over the subset of pairs that
  // captured the relevant metric. A pair is missing perf when generateDraft
  // threw (status==='draft_failed') OR when the endpoint didn't return the
  // Ollama-shape token counts. aggregate() returns zeros on an empty input
  // so the JSON shape stays stable when no perf data was captured.
  const latencies = per_pair
    .filter((p) => typeof p.latency_ms === 'number')
    .map((p) => p.latency_ms as number);
  const tokens_in = per_pair
    .filter((p) => typeof p.tokens_in === 'number')
    .map((p) => p.tokens_in as number);
  const tokens_out = per_pair
    .filter((p) => typeof p.tokens_out === 'number')
    .map((p) => p.tokens_out as number);
  const tps = per_pair
    .filter((p) => typeof p.tokens_per_second === 'number')
    .map((p) => p.tokens_per_second as number);

  const latency_ms_aggregates = latencies.length > 0 ? aggregate(latencies) : undefined;
  const tokens_in_aggregates = tokens_in.length > 0 ? aggregate(tokens_in) : undefined;
  const tokens_out_aggregates = tokens_out.length > 0 ? aggregate(tokens_out) : undefined;
  const tokens_per_second_aggregates = tps.length > 0 ? aggregate(tps) : undefined;

  // Run tag default: `eval-<drafter_model_safe>-<YYYY-MM-DD>`. Sanitize the
  // model name by stripping `:` and `/` (filename-unsafe) and lowercasing.
  const generated_at = new Date().toISOString();
  const dateOnly = generated_at.slice(0, 10);
  const safeModel = drafter_model.replace(/[:/]/g, '-').toLowerCase();
  const derivedRunTag = `eval-${safeModel}-${dateOnly}`;

  return {
    generated_at,
    mode,
    drafter_model,
    embed_model,
    sample_size_requested,
    sample_size_actual: per_pair.length,
    run_tag: run_tag ?? derivedRunTag,
    trace_set,
    latency_ms_aggregates,
    tokens_in_aggregates,
    tokens_out_aggregates,
    tokens_per_second_aggregates,
    aggregates_global: aggregate(okScores),
    aggregates_by_category,
    judge_provider,
    judge_aggregates_global,
    judge_aggregates_by_category,
    per_pair,
    status_counts,
  };
}

export interface ParsedArgs {
  limit: number | 'all';
  // STAQPRO-220 — judge mode. `null` means cosine-only (existing behavior).
  // `judge_only=true` skips the cosine path and only runs the judge — used
  // for re-scoring an already-eval'd corpus without re-paying for the
  // 67-min Qwen3 draft + embed loop.
  judge: JudgeProvider | null;
  judge_only: boolean;
  // STAQPRO-340 — trace-set path (offline replacement for the DB-driven
  // sample). `null` means the existing DB path (read from sent_history).
  // When set, the harness loads pairs from `<dir>/manifest.json` +
  // `<dir>/*.trace.json` and ignores POSTGRES_URL.
  trace_set: string | null;
  // STAQPRO-340 — explicit run tag for the bake-off `eval-{model}-{date}`
  // convention. Defaults to a derived value when omitted.
  run_tag: string | null;
}

const JUDGE_PROVIDERS: readonly JudgeProvider[] = ['haiku', 'gpt-oss'];

function parseJudgeValue(flag: string, v: string | undefined): JudgeProvider {
  if (v === undefined || v === '') {
    throw new Error(`${flag} requires a value (one of: ${JUDGE_PROVIDERS.join(', ')})`);
  }
  if (!JUDGE_PROVIDERS.includes(v as JudgeProvider)) {
    throw new Error(`${flag} must be one of ${JUDGE_PROVIDERS.join(', ')}, got: ${v}`);
  }
  return v as JudgeProvider;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let limit: number | 'all' = 'all';
  let judge: JudgeProvider | null = null;
  let judge_only = false;
  let trace_set: string | null = null;
  let run_tag: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') {
      const v = argv[i + 1];
      if (v === undefined || v === '') throw new Error('--limit requires a value');
      if (v === 'all') {
        limit = 'all';
      } else {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--limit must be 'all' or a positive number, got: ${v}`);
        }
        limit = Math.floor(n);
      }
      i++;
      continue;
    }
    if (a === '--judge') {
      judge = parseJudgeValue('--judge', argv[i + 1]);
      i++;
      continue;
    }
    if (a?.startsWith('--judge=')) {
      judge = parseJudgeValue('--judge', a.slice('--judge='.length));
      continue;
    }
    if (a === '--judge-only') {
      judge = parseJudgeValue('--judge-only', argv[i + 1]);
      judge_only = true;
      i++;
      continue;
    }
    if (a?.startsWith('--judge-only=')) {
      judge = parseJudgeValue('--judge-only', a.slice('--judge-only='.length));
      judge_only = true;
      continue;
    }
    if (a === '--trace-set') {
      const v = argv[i + 1];
      if (v === undefined || v === '') throw new Error('--trace-set requires a value');
      trace_set = v;
      i++;
      continue;
    }
    if (a?.startsWith('--trace-set=')) {
      trace_set = a.slice('--trace-set='.length);
      continue;
    }
    if (a === '--run-tag') {
      const v = argv[i + 1];
      if (v === undefined || v === '') throw new Error('--run-tag requires a value');
      run_tag = v;
      i++;
      continue;
    }
    if (a?.startsWith('--run-tag=')) {
      run_tag = a.slice('--run-tag='.length);
    }
  }
  return { limit, judge, judge_only, trace_set, run_tag };
}

// =============================================================================
// I/O helpers (mocked in tests)
// =============================================================================

export interface PairRow {
  sent_history_id: number;
  sent_message_id: string;
  actual_reply_body: string;
  reply_sent_at: string;
  inbox_id: number;
  inbox_message_id: string;
  inbox_from: string | null;
  inbox_subject: string | null;
  inbox_body: string;
  inbox_classification: string | null;
  inbox_confidence: number | null;
  // STAQPRO-222 (H3) — supplied to retrieveForDraft so same-thread refs are
  // dropped when RAG_RETRIEVE_EXCLUDE_SAME_THREAD=1. Nullable on the off
  // chance an old backfill row didn't capture thread_id (defensive — the
  // live ingest path sets it).
  inbox_thread_id: string | null;
}

const DEFAULT_PERSONA_KEY = 'default';

/**
 * Assemble the same prompt the live drafter would build for this inbound
 * and POST it to Ollama /api/chat. Returns the generated draft body.
 *
 * Path-of-least-divergence: same getPersonaContext + retrieveForDraft +
 * pickEndpoint + assemblePrompt that /api/internal/draft-prompt uses; the
 * only thing skipped is the mailbox.drafts.rag_context_refs writeback (the
 * harness doesn't write to the drafts table — eval is read-only against
 * Postgres).
 *
 * Fallback for inbox rows that don't carry a real classification (most
 * backfill rows): default to 'inquiry' which routes LOCAL — same path the
 * live drafter takes for low-confidence inbounds.
 */
export interface DrafterDeps {
  fetchFn?: typeof fetch;
  retrieve?: typeof retrieveForDraft;
  resolvePersona?: typeof getPersonaContext;
}

/**
 * STAQPRO-340 — extra Ollama response fields the harness captures for the
 * bake-off perf metrics. Optional everywhere because (a) Ollama only emits
 * them on the final non-streaming response object, and (b) cloud endpoints
 * (Anthropic, Ollama Cloud) emit a different shape. Pairs without metrics
 * just leave `latency_ms` / `tokens_*` undefined on the per-pair record.
 */
export interface OllamaPerfMetrics {
  latency_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  tokens_per_second?: number;
}

export interface GenerateDraftResult {
  body: string;
  refs_count: number;
  reason: RetrievalResult['reason'];
  perf: OllamaPerfMetrics;
}

export async function generateDraft(
  pair: PairRow,
  deps: DrafterDeps = {},
): Promise<GenerateDraftResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const retrieve = deps.retrieve ?? retrieveForDraft;
  const resolvePersona = deps.resolvePersona ?? getPersonaContext;

  // Backfill rows are unclassified — default to 'inquiry' so route is LOCAL.
  // Confidence floors at 1.0 to skip the <0.75 cloud-safety-net (eval is
  // local-route only per the issue's out-of-scope guardrail).
  const category: Category = (pair.inbox_classification as Category | null) ?? 'inquiry';
  const confidence = pair.inbox_confidence ?? 1.0;

  // MBOX-352 — getPersonaContext is now account-scoped (numeric account_id);
  // the eval harness runs against the default account, so pass nothing.
  const persona = await resolvePersona();
  const endpoint = pickEndpoint(category, confidence);
  // Eval covers LOCAL route only. If routing decides cloud (escalate /
  // unknown), surface that as a soft skip via the retrieval reason — the
  // operator should re-run with a category filter if they care.
  const retrieval = await retrieve({
    from_addr: pair.inbox_from ?? '',
    subject: pair.inbox_subject ?? null,
    body_text: pair.inbox_body ?? null,
    draft_source: endpoint.source,
    persona_key: DEFAULT_PERSONA_KEY,
    // STAQPRO-219 — drop self-match from retrieval so the eval measures
    // real-prior recall, not unit-cosine self-cosine. Same path the live
    // drafter takes via /api/internal/draft-prompt.
    message_id: pair.inbox_message_id,
    // STAQPRO-222 (H3) — same-thread refs are gated by
    // RAG_RETRIEVE_EXCLUDE_SAME_THREAD inside retrieveForDraft. The eval
    // pass-on-vs-off compares the with-flag run against the same baseline
    // run; the harness just plumbs the thread_id through.
    thread_id: pair.inbox_thread_id,
  });
  const assembled = assemblePrompt({
    from_addr: pair.inbox_from ?? '',
    to_addr: '',
    subject: pair.inbox_subject ?? '',
    body_text: pair.inbox_body ?? '',
    category,
    confidence,
    persona,
    rag_refs: retrieval.refs,
  });

  // POST to Ollama /api/chat (matching n8n MailBOX-Draft exactly).
  const url = `${endpoint.baseUrl}/api/chat`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
  // STAQPRO-340 — wall-clock latency. Captured around the fetch + json read
  // so the number reflects what the live drafter would experience (network
  // + Ollama queue + inference + JSON serialize). Cloud endpoints get the
  // same measurement; tokens_per_second derived below from eval_count /
  // eval_duration is Ollama-shape-specific and absent on non-Ollama paths.
  const startMs = performance.now();
  const res = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: endpoint.model,
      messages: assembled.messages,
      stream: false,
      options: {
        temperature: assembled.temperature,
        num_predict: assembled.max_tokens,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`ollama /api/chat returned ${res.status}: ${await res.text()}`);
  }
  // Ollama /api/chat non-streaming response shape:
  //   message.content        — draft body
  //   prompt_eval_count      — input tokens
  //   eval_count             — output tokens
  //   eval_duration          — output generation duration (ns)
  //
  // See lib/drafting/ollama.ts for the canonical typing.
  const data = (await res.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
    eval_duration?: number;
  };
  const latency_ms = performance.now() - startMs;
  const content = data.message?.content ?? '';

  const perf: OllamaPerfMetrics = { latency_ms };
  if (typeof data.prompt_eval_count === 'number') {
    perf.tokens_in = data.prompt_eval_count;
  }
  if (typeof data.eval_count === 'number') {
    perf.tokens_out = data.eval_count;
  }
  if (
    typeof data.eval_count === 'number' &&
    typeof data.eval_duration === 'number' &&
    data.eval_duration > 0
  ) {
    // eval_duration is in nanoseconds per Ollama API; t/s = tokens / seconds.
    perf.tokens_per_second = data.eval_count / (data.eval_duration / 1_000_000_000);
  }

  return {
    body: content,
    refs_count: retrieval.refs.length,
    reason: retrieval.reason,
    perf,
  };
}

export interface ScorePairDeps extends DrafterDeps {
  embedFn?: typeof embedText;
  // STAQPRO-220 — pluggable judge call for tests. Production uses the real
  // callJudge from lib/drafting/judge.ts.
  judgeFn?: typeof callJudge;
}

export interface ScorePairOptions {
  /**
   * STAQPRO-220 — when set, run the LLM-judge in addition to (or instead
   * of, under judge_only) cosine. The harness owns the decision; the call
   * site here just plugs it in per pair so the per-pair object can carry
   * judge_* fields alongside cosine.
   */
  judge?: JudgeProvider | null;
  judge_only?: boolean;
}

export async function scorePair(
  pair: PairRow,
  deps: ScorePairDeps = {},
  options: ScorePairOptions = {},
): Promise<PerPairScore> {
  const embedFn = deps.embedFn ?? embedText;
  const judgeFn = deps.judgeFn ?? callJudge;
  const judgeProvider = options.judge ?? null;
  const judgeOnly = options.judge_only === true && judgeProvider !== null;

  const base: Omit<
    PerPairScore,
    'cosine' | 'rag_refs_count' | 'rag_reason' | 'draft_chars' | 'status'
  > & {
    cosine: number | null;
    rag_refs_count: number;
    rag_reason: RetrievalResult['reason'];
    draft_chars: number;
    status: PerPairScore['status'];
  } = {
    sent_history_id: pair.sent_history_id,
    inbox_message_id: pair.inbox_message_id,
    classification: pair.inbox_classification,
    cosine: null,
    rag_refs_count: 0,
    rag_reason: 'no_hits',
    draft_chars: 0,
    actual_chars: pair.actual_reply_body.length,
    status: 'error',
  };

  let draftBody = '';
  let refs_count = 0;
  let reason: RetrievalResult['reason'] = 'no_hits';
  let perf: OllamaPerfMetrics = {};
  try {
    const drafted = await generateDraft(pair, deps);
    draftBody = drafted.body;
    refs_count = drafted.refs_count;
    reason = drafted.reason;
    perf = drafted.perf;
  } catch (err) {
    return { ...base, status: 'draft_failed', error: errorMessage(err) };
  }

  base.draft_chars = draftBody.length;
  base.rag_refs_count = refs_count;
  base.rag_reason = reason;
  // STAQPRO-340 — perf metrics are merged onto every non-draft_failed
  // record. Undefined fields drop out of JSON serialization automatically,
  // so cosine-only / judge-only runs keep the same JSON shape on cloud
  // endpoints that don't emit Ollama-style metrics.
  if (perf.latency_ms !== undefined) base.latency_ms = perf.latency_ms;
  if (perf.tokens_in !== undefined) base.tokens_in = perf.tokens_in;
  if (perf.tokens_out !== undefined) base.tokens_out = perf.tokens_out;
  if (perf.tokens_per_second !== undefined) base.tokens_per_second = perf.tokens_per_second;

  if (!draftBody.trim() || !pair.actual_reply_body.trim()) {
    return { ...base, status: 'embed_failed', error: 'empty draft or actual reply' };
  }

  // Cosine path — skipped when --judge-only is set, so the harness can
  // re-score an already-eval'd corpus without paying for embed calls.
  let cosine: number | null = null;
  let cosineFailed: { error: string } | null = null;
  if (!judgeOnly) {
    const [draftVec, actualVec] = await Promise.all([
      embedFn(draftBody),
      embedFn(pair.actual_reply_body),
    ]);
    if (!draftVec || !actualVec) {
      cosineFailed = { error: 'embed returned null' };
    } else {
      cosine = cosineSimilarity(draftVec, actualVec);
    }
  }

  // Judge path — runs alongside cosine when --judge=... is set, OR alone
  // when --judge-only=... is set. Failures here populate judge_status and
  // judge_error but do not poison the cosine result; the aggregate code
  // filters on judge_status === 'ok'.
  let judgeFields: Pick<
    PerPairScore,
    | 'judge_provider'
    | 'judge_status'
    | 'judge_score'
    | 'judge_voice'
    | 'judge_facts'
    | 'judge_length'
    | 'judge_rationale'
    | 'judge_error'
  > = {};
  if (judgeProvider) {
    const judgeResult = await judgeFn(judgeProvider, {
      draft: draftBody,
      actual_reply: pair.actual_reply_body,
    });
    judgeFields = applyJudgeResult(judgeProvider, judgeResult);
  }

  // Decide final status. Cosine-only legacy path keeps `embed_failed`
  // semantics. judge-only path uses `judge_only` if cosine wasn't attempted
  // (so the operator can read status_counts.judge_only and know it was an
  // intentional no-cosine run, not an embed outage).
  if (judgeOnly) {
    return {
      ...base,
      ...judgeFields,
      cosine: null,
      status: 'judge_only',
    };
  }
  if (cosineFailed) {
    return { ...base, ...judgeFields, status: 'embed_failed', error: cosineFailed.error };
  }
  return {
    ...base,
    ...judgeFields,
    cosine,
    status: 'ok',
  };
}

/**
 * STAQPRO-220 — translate a JudgeResult into the JSON-friendly per-pair
 * fields. Centralized so the shape is consistent across the cosine-and-
 * judge and the judge-only paths.
 */
function applyJudgeResult(
  provider: JudgeProvider,
  result: JudgeResult,
): Pick<
  PerPairScore,
  | 'judge_provider'
  | 'judge_status'
  | 'judge_score'
  | 'judge_voice'
  | 'judge_facts'
  | 'judge_length'
  | 'judge_rationale'
  | 'judge_error'
> {
  if (result.status === 'ok' && result.scores) {
    const s: JudgeScores = result.scores;
    return {
      judge_provider: provider,
      judge_status: 'ok',
      judge_score: judgeScoreSum(s),
      judge_voice: s.voice_match,
      judge_facts: s.factual_alignment,
      judge_length: s.length_appropriateness,
      judge_rationale: s.rationale,
    };
  }
  return {
    judge_provider: provider,
    judge_status: result.status,
    judge_error: result.error,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// =============================================================================
// CLI entry point
// =============================================================================

function summaryTable(report: RagEvalReport): string {
  const g = report.aggregates_global;
  const lines: string[] = [];
  lines.push('');
  lines.push(`RAG eval — mode=${report.mode} model=${report.drafter_model}`);
  lines.push(
    `pairs: ${report.sample_size_actual} (requested ${report.sample_size_requested})  ok=${report.status_counts.ok} draft_failed=${report.status_counts.draft_failed} embed_failed=${report.status_counts.embed_failed} error=${report.status_counts.error} judge_only=${report.status_counts.judge_only} judge_failed=${report.status_counts.judge_failed} judge_rate_limited=${report.status_counts.judge_rate_limited}`,
  );
  lines.push('');
  lines.push('Global cosine similarity:');
  lines.push(
    `  count=${g.count}  mean=${g.mean.toFixed(4)}  median=${g.median.toFixed(4)}  p25=${g.p25.toFixed(4)}  p75=${g.p75.toFixed(4)}  min=${g.min.toFixed(4)}  max=${g.max.toFixed(4)}`,
  );
  if (Object.keys(report.aggregates_by_category).length > 0) {
    lines.push('');
    lines.push('Per-category:');
    for (const [cat, agg] of Object.entries(report.aggregates_by_category)) {
      lines.push(
        `  ${cat.padEnd(16)} count=${String(agg.count).padStart(4)}  mean=${agg.mean.toFixed(4)}  median=${agg.median.toFixed(4)}`,
      );
    }
  }
  if (report.judge_provider && report.judge_aggregates_global) {
    const j = report.judge_aggregates_global;
    lines.push('');
    lines.push(`Global judge score (provider=${report.judge_provider}, range 0-9):`);
    lines.push(
      `  count=${j.count}  mean=${j.mean.toFixed(3)}  median=${j.median.toFixed(3)}  p25=${j.p25.toFixed(3)}  p75=${j.p75.toFixed(3)}  min=${j.min.toFixed(3)}  max=${j.max.toFixed(3)}`,
    );
    if (
      report.judge_aggregates_by_category &&
      Object.keys(report.judge_aggregates_by_category).length > 0
    ) {
      lines.push('');
      lines.push('Judge per-category:');
      for (const [cat, agg] of Object.entries(report.judge_aggregates_by_category)) {
        lines.push(
          `  ${cat.padEnd(16)} count=${String(agg.count).padStart(4)}  mean=${agg.mean.toFixed(3)}  median=${agg.median.toFixed(3)}`,
        );
      }
    }
  }
  // STAQPRO-340 — perf metrics block. Renders only when at least one perf
  // aggregate is non-empty; bake-off operators read this directly to verify
  // the DR-21 ≥ 15 t/s and ≤ 3.4 GiB gates (peak memory is captured outside
  // the harness via `nvidia-smi --query-gpu=memory.used` polling).
  const hasPerf =
    report.latency_ms_aggregates ||
    report.tokens_in_aggregates ||
    report.tokens_out_aggregates ||
    report.tokens_per_second_aggregates;
  if (hasPerf) {
    lines.push('');
    lines.push(`Perf metrics (run_tag=${report.run_tag}):`);
    if (report.tokens_per_second_aggregates) {
      const t = report.tokens_per_second_aggregates;
      lines.push(
        `  tokens/sec       count=${String(t.count).padStart(4)}  mean=${t.mean.toFixed(2)}  median=${t.median.toFixed(2)}  p25=${t.p25.toFixed(2)}  p75=${t.p75.toFixed(2)}`,
      );
    }
    if (report.latency_ms_aggregates) {
      const l = report.latency_ms_aggregates;
      lines.push(
        `  latency_ms       count=${String(l.count).padStart(4)}  mean=${l.mean.toFixed(0)}  median=${l.median.toFixed(0)}  p25=${l.p25.toFixed(0)}  p75=${l.p75.toFixed(0)}`,
      );
    }
    if (report.tokens_in_aggregates) {
      const ti = report.tokens_in_aggregates;
      lines.push(
        `  tokens_in        count=${String(ti.count).padStart(4)}  mean=${ti.mean.toFixed(0)}  median=${ti.median.toFixed(0)}`,
      );
    }
    if (report.tokens_out_aggregates) {
      const to = report.tokens_out_aggregates;
      lines.push(
        `  tokens_out       count=${String(to.count).padStart(4)}  mean=${to.mean.toFixed(0)}  median=${to.median.toFixed(0)}`,
      );
    }
  }
  if (report.trace_set) {
    lines.push('');
    lines.push(
      `Trace set: version=${report.trace_set.set_version} sha=${report.trace_set.set_sha256.slice(0, 16)}… appliance=${report.trace_set.source_appliance} count=${report.trace_set.count}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * STAQPRO-340 — load a trace set from disk. Returns the `PairRow[]` shape
 * the existing scorePair / generateDraft path already consumes plus the
 * `TraceSetProvenance` that gets carried onto the report.
 *
 * Failure modes:
 *   - missing manifest.json → throw
 *   - manifest fails zod or `verifyManifest` (set_sha256 mismatch) → throw
 *   - a `*.trace.json` file fails zod → throw
 *   - a trace's recomputed SHA-256 doesn't match its manifest entry → throw
 *
 * The harness deliberately fails LOUD on any integrity issue. RAG was the
 * "soft-fail on infra outage" path; eval is the "must be reproducible" path.
 */
export async function loadTraceSet(
  dir: string,
): Promise<{ pairs: PairRow[]; provenance: TraceSetProvenance }> {
  const manifestPath = path.join(dir, 'manifest.json');
  const manifestRaw = await readFile(manifestPath, 'utf-8');
  const manifest = traceManifestSchema.parse(JSON.parse(manifestRaw));

  const verdict = verifyManifest(manifest);
  if (!verdict.ok) {
    throw new Error(
      `trace-set manifest verification failed: ${verdict.reason} (expected=${verdict.expected ?? 'n/a'}, actual=${verdict.actual ?? 'n/a'})`,
    );
  }

  // Cross-check: the directory should contain exactly the files listed in
  // manifest.entries (modulo manifest.json itself, README, .gitignore, etc).
  const filesOnDisk = new Set((await readdir(dir)).filter((f) => f.endsWith('.trace.json')));
  const filesInManifest = new Set(manifest.entries.map((e) => e.filename));
  for (const f of filesInManifest) {
    if (!filesOnDisk.has(f)) {
      throw new Error(`trace-set: manifest references missing file ${f}`);
    }
  }

  const pairs: PairRow[] = [];
  // Iterate in manifest order for deterministic run-to-run output ordering.
  for (const entry of manifest.entries) {
    const traceRaw = await readFile(path.join(dir, entry.filename), 'utf-8');
    const trace = traceSchema.parse(JSON.parse(traceRaw)) satisfies Trace;
    // The harness uses the raw on-disk bytes to compute the SHA-256, so a
    // mismatch here means either the trace file has been edited
    // out-of-band or the format-version regenerator changed the canonical
    // JSON shape. Both block the run.
    const expected = entry.trace_sha256;
    // Re-canonicalize and re-hash to catch out-of-band edits (e.g., an
    // editor stripped a trailing newline). Cheap insurance.
    const recomputed = createSha256OfTraceFileBytes(traceRaw);
    if (recomputed !== expected) {
      throw new Error(
        `trace-set: ${entry.filename} sha256 mismatch (expected=${expected}, actual=${recomputed})`,
      );
    }

    pairs.push({
      sent_history_id: trace.provenance.sent_history_id,
      sent_message_id: trace.inbox_message_id,
      // Treat actual_reply_body as the canonical "what we should match".
      actual_reply_body: trace.actual_reply_body,
      reply_sent_at: trace.reply_sent_at,
      inbox_id: trace.provenance.inbox_id,
      inbox_message_id: trace.inbox_message_id,
      inbox_from: trace.inbox_from,
      inbox_subject: trace.inbox_subject,
      inbox_body: trace.inbox_body,
      inbox_classification: trace.classification,
      inbox_confidence: trace.inbox_confidence,
      inbox_thread_id: trace.inbox_thread_id,
    });
  }

  const provenance: TraceSetProvenance = {
    dir,
    set_version: manifest.set_version,
    set_sha256: manifest.set_sha256,
    source_appliance: manifest.source_appliance,
    count: manifest.count,
  };

  return { pairs, provenance };
}

/**
 * SHA-256 over the raw on-disk bytes of a trace JSON file. Matches
 * `hashTrace` in `lib/eval/trace-set.ts` when the file was written by
 * `traceToCanonicalJson` and hasn't been edited out-of-band. The integrity
 * check catches editor-introduced whitespace drift, trailing-newline loss,
 * or any other byte-level mutation that would silently break the
 * content-addressed contract.
 */
function createSha256OfTraceFileBytes(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf-8').digest('hex');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode: 'with-rag' | 'no-rag' = process.env.RAG_DISABLED === '1' ? 'no-rag' : 'with-rag';
  const drafterModel = process.env.RAG_EVAL_DRAFTER_MODEL ?? 'qwen3:4b-ctx4k';
  const embedModel = process.env.EMBED_MODEL ?? 'nomic-embed-text:v1.5';
  const judgeProvider = args.judge;
  const judgeOnly = args.judge_only;
  const useTraceSet = args.trace_set !== null;

  // POSTGRES_URL is only required on the DB-driven path. Trace-set runs
  // operate offline against the committed corpus.
  const postgresUrl = process.env.POSTGRES_URL;
  if (!useTraceSet && !postgresUrl) {
    throw new Error('POSTGRES_URL not set (required unless --trace-set is used)');
  }

  // STAQPRO-220 — privacy notice. The judge sees draft + actual reply bytes;
  // both go to whichever cloud the operator picked. The runbook documents
  // this; the harness echoes it on every judge run so it's hard to miss.
  if (judgeProvider) {
    const cloud = judgeProvider === 'haiku' ? 'Anthropic' : 'Ollama Cloud';
    console.log(
      `[rag-eval] judge=${judgeProvider} (${cloud}) judge_only=${judgeOnly} — draft + actual reply bytes WILL be sent to the cloud provider`,
    );
  }

  // STAQPRO-224 — pacing between judge calls to stay under Anthropic's 50 RPM
  // standard-tier ceiling for Haiku. 500ms gap = ~120 RPM theoretical but
  // serialized so actually ~60 RPM after request latency. Operator can set
  // 0 for fast smoke runs (`--limit 5`) or raise it on a noisy tier. Has no
  // effect on cosine-only runs (no judge call to space).
  const judgeRateLimitMs = Number.parseInt(process.env.JUDGE_RATE_LIMIT_MS ?? '500', 10);
  if (judgeProvider && judgeRateLimitMs > 0) {
    console.log(`[rag-eval] judge pacing: ${judgeRateLimitMs}ms between calls`);
  }

  console.log(
    `[rag-eval] mode=${mode} limit=${args.limit} drafter=${drafterModel} embed=${embedModel} source=${useTraceSet ? `trace-set:${args.trace_set}` : 'postgres'}`,
  );

  let pairs: PairRow[];
  let traceProvenance: TraceSetProvenance | undefined;
  let pool: Pool | null = null;

  if (useTraceSet && args.trace_set !== null) {
    const loaded = await loadTraceSet(args.trace_set);
    pairs = loaded.pairs;
    traceProvenance = loaded.provenance;
    console.log(
      `[rag-eval] loaded trace set version=${loaded.provenance.set_version} sha=${loaded.provenance.set_sha256.slice(0, 16)}… count=${loaded.provenance.count}`,
    );
    // --limit applies to trace-set runs too — useful for smoke runs against
    // a large committed set. `all` keeps the full set.
    if (args.limit !== 'all') {
      pairs = pairs.slice(0, args.limit);
    }
  } else {
    if (!postgresUrl) throw new Error('unreachable: postgres path without POSTGRES_URL');
    pool = new Pool({ connectionString: postgresUrl, max: 2 });
    const sql = buildSampleSql(args.limit === 'all' ? null : args.limit);
    const r = await pool.query<PairRow>(sql);
    pairs = r.rows;
  }
  console.log(`[rag-eval] scoring ${pairs.length} (inbound, reply) pairs`);

  try {
    const perPair: PerPairScore[] = [];
    let i = 0;
    for (const pair of pairs) {
      i += 1;
      try {
        const score = await scorePair(pair, {}, { judge: judgeProvider, judge_only: judgeOnly });
        perPair.push(score);
      } catch (err) {
        perPair.push({
          sent_history_id: pair.sent_history_id,
          inbox_message_id: pair.inbox_message_id,
          classification: pair.inbox_classification,
          cosine: null,
          rag_refs_count: 0,
          rag_reason: 'no_hits',
          draft_chars: 0,
          actual_chars: pair.actual_reply_body.length,
          status: 'error',
          error: errorMessage(err),
        });
      }
      if (i % 10 === 0 || i === pairs.length) {
        const ok = perPair.filter((p) => p.status === 'ok').length;
        const judgeOk = judgeProvider
          ? perPair.filter((p) => p.judge_status === 'ok').length
          : null;
        const judgeFragment = judgeOk === null ? '' : ` judge_ok=${judgeOk}`;
        console.log(`[rag-eval] ${i}/${pairs.length} ok=${ok}${judgeFragment}`);
      }
      // STAQPRO-224 — sleep AFTER scoring (not before) so the first call has
      // zero gap and the run starts immediately. Skip on the last iteration
      // to avoid a dead-air pause before summary print.
      if (judgeProvider && judgeRateLimitMs > 0 && i < pairs.length) {
        await new Promise((r) => setTimeout(r, judgeRateLimitMs));
      }
    }

    const report = buildReport({
      mode,
      drafter_model: drafterModel,
      embed_model: embedModel,
      sample_size_requested: args.limit,
      per_pair: perPair,
      judge_provider: judgeProvider ?? undefined,
      run_tag: args.run_tag ?? undefined,
      trace_set: traceProvenance,
    });

    const outDir = path.resolve(process.cwd(), 'eval-results');
    await mkdir(outDir, { recursive: true });
    const ts = report.generated_at.replace(/[:.]/g, '-');
    // Tag judge runs in the filename so cosine-only and judge runs don't
    // collide in eval-results/. judge-only runs land with `-judge-<provider>`
    // suffix so they're trivially globbable.
    const judgeSuffix = judgeProvider
      ? judgeOnly
        ? `-judge-only-${judgeProvider}`
        : `-judge-${judgeProvider}`
      : '';
    // STAQPRO-340 — run-tag goes in the filename too so the bake-off can
    // shell-glob `eval-${model}-*.json` for cross-model aggregation.
    const tagSuffix = `-${report.run_tag}`;
    const outPath = path.join(outDir, `rag-eval-${ts}-${mode}${judgeSuffix}${tagSuffix}.json`);
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf-8');

    console.log(summaryTable(report));
    console.log(`[rag-eval] wrote ${outPath}`);
  } finally {
    if (pool) await pool.end();
  }
}

// Only run when invoked directly (not when imported by tests).
const isDirect =
  // tsx / node-style entrypoint check — robust to both `node script.ts` and
  // `tsx scripts/x.ts` invocations.
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /rag-eval-harness\.(ts|js|mjs|cjs)$/.test(process.argv[1]);

if (isDirect) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
