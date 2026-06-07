#!/usr/bin/env -S npx tsx

// dashboard/scripts/concurrency-bench.ts
//
// MBOX-162 spike S1 — multi-account T2 concurrency benchmark CLI.
//
// Purpose: runner for the S1 harness defined in lib/eval/concurrency-bench.ts.
// Measures whether a Jetson (T2) can classify+draft for N accounts in both
// `serialized` and `concurrent` scheduling modes without breaching the S1 gate
// from docs/addendum-mailbox-multi-account-v0_1-2026-05-20.md §6 and the DR-45
// kill criterion: classify p95 < 5000ms AND peak memory ≤ 4.0 GiB.
//
// The real run executes on the live M1 appliance in an operator-scheduled quiet
// window (not run here — this CLI is the runner, not the measurement). Tests in
// test/lib/concurrency-bench.test.ts exercise the lib deterministically without
// hitting any live endpoint.
//
// Usage (3 accounts, both modes, against live M1):
//   npx tsx scripts/concurrency-bench.ts \
//     --trace-set eval/t2-traces/v1.0 \
//     --classify-base-url http://192.168.50.179:11434 \
//     --draft-base-url http://192.168.50.179:8080 \
//     --accounts 3 \
//     --mode both \
//     --run-tag concurrency-s1-2026-05-28 \
//     --out eval/results
//
// Outputs (under eval/results/ — gitignored; do NOT commit result artifacts):
//   {run-tag}.summary.json   — run provenance + ConcurrencyBenchResult[]
//   {run-tag}.verdict.md     — markdown verdict table + DR-45 interpretation
//
// Note: eval/results/ is gitignored per the bake-off-harness precedent.
// Never commit files under that directory.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ModelEndpoint } from '../lib/eval/bake-off';
import {
  type AccountConfig,
  type BenchMode,
  type ConcurrencyBenchResult,
  evaluateS1Verdict,
  runConcurrencyBench,
} from '../lib/eval/concurrency-bench';
import {
  type Trace,
  traceManifestSchema,
  traceSchema,
  verifyManifest,
} from '../lib/eval/trace-set';

// ── Arg types ──────────────────────────────────────────────────────────

interface CliArgs {
  /** Number of synthetic accounts to simulate. Default 3. */
  accounts: number;
  /** Ollama base URL for classify calls. Default http://localhost:11434. */
  classify_base_url: string;
  /** Classify model tag. Default qwen3:4b-ctx4k. */
  classify_model: string;
  /** llama.cpp base URL for draft calls. Default http://localhost:8080. */
  draft_base_url: string;
  /** Draft model tag. Default qwen3-4b-ctx4k. */
  draft_model: string;
  /** Trace-set directory. Must contain manifest.json + *.trace.json. */
  trace_set: string;
  /** Which mode(s) to run. Default 'both'. */
  mode: BenchMode | 'both';
  /** Output directory. Default eval/results. */
  out: string;
  /** Output filename prefix. Default concurrency-bench-<ISO-date>. */
  run_tag: string;
  // Provenance / decoding (mirrors bake-off-harness flags):
  context_length: number;
  runtime_sha: string;
  quantization: string;
  temperature: number;
  seed: number;
  num_predict: number;
}

// ── USAGE ──────────────────────────────────────────────────────────────

const USAGE = `concurrency-bench — MBOX-162 S1 multi-account T2 concurrency benchmark

Run N-account classify+draft workloads in serialized and/or concurrent modes,
measuring classify p95 and peak memory against the S1 gate (addendum §6 / DR-45).

Options:
  --accounts <n>             Number of synthetic accounts (default: 3; env: MBOX_BENCH_ACCOUNTS)
  --classify-base-url <url>  Ollama base URL for /api/generate (env: OLLAMA_BASE_URL; default: http://localhost:11434)
  --classify-model <tag>     Classify model tag (default: qwen3:4b-ctx4k)
  --draft-base-url <url>     llama.cpp base URL for /v1/chat/completions (default: http://localhost:8080)
  --draft-model <tag>        Draft model tag (default: qwen3-4b-ctx4k)
  --trace-set <dir>          Trace-set directory containing manifest.json + *.trace.json
  --mode <serialized|concurrent|both>  Scheduling mode(s) to run (default: both)
  --out <dir>                Output directory (default: eval/results)
  --run-tag <tag>            Output filename prefix (default: concurrency-bench-<today>)

Provenance (recommended for reproducibility):
  --context-length <n>       Context length (default: 4096)
  --runtime-sha <sha>        llama.cpp git SHA at server start (default: unknown)
  --quantization <q>         Quantization tag (default: Q4_K_M)
  --temperature <f>          Decoding temperature (default: 0)
  --seed <n>                 Decoding seed (default: 42)
  --num-predict <n>          Max output tokens (default: 512)

  --help / -h                Print this message and exit

NOTE: eval/results/ is gitignored. Do NOT commit result artifacts.
NOTE: This CLI does NOT run against any live endpoint by default. Set the
      base URLs above to point at a running appliance for the real S1 run.
`;

// ── parseArgs ──────────────────────────────────────────────────────────

export function parseArgs(argv: readonly string[]): CliArgs {
  const today = new Date().toISOString().slice(0, 10);

  // Defaults (env as fallback; flags win).
  let accounts = parseIntStrict(process.env.MBOX_BENCH_ACCOUNTS ?? '3', 'MBOX_BENCH_ACCOUNTS');
  let classify_base_url = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  let classify_model = 'qwen3:4b-ctx4k';
  let draft_base_url = 'http://localhost:8080';
  let draft_model = 'qwen3-4b-ctx4k';
  let trace_set: string | null = null;
  let mode: BenchMode | 'both' = 'both';
  let out = 'eval/results';
  let run_tag = `concurrency-bench-${today}`;
  let context_length = 4096;
  let runtime_sha = 'unknown';
  let quantization = 'Q4_K_M';
  let temperature = 0;
  let seed = 42;
  let num_predict = 512;

  const need = (flag: string, v: string | undefined): string => {
    if (v === undefined || v === '') throw new Error(`${flag} requires a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;

    if (a === '--accounts') {
      accounts = parseIntStrict(need('--accounts', argv[i + 1]), '--accounts');
      i++;
      continue;
    }
    if (a === '--classify-base-url') {
      classify_base_url = need('--classify-base-url', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--classify-model') {
      classify_model = need('--classify-model', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--draft-base-url') {
      draft_base_url = need('--draft-base-url', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--draft-model') {
      draft_model = need('--draft-model', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--trace-set') {
      trace_set = need('--trace-set', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--mode') {
      const raw = need('--mode', argv[i + 1]);
      if (raw !== 'serialized' && raw !== 'concurrent' && raw !== 'both') {
        throw new Error(`--mode must be serialized, concurrent, or both; got: ${raw}`);
      }
      mode = raw;
      i++;
      continue;
    }
    if (a === '--out') {
      out = need('--out', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--run-tag') {
      run_tag = need('--run-tag', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--context-length') {
      context_length = parseIntStrict(need('--context-length', argv[i + 1]), '--context-length');
      i++;
      continue;
    }
    if (a === '--runtime-sha') {
      runtime_sha = need('--runtime-sha', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--quantization') {
      quantization = need('--quantization', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--temperature') {
      temperature = parseFloatStrict(need('--temperature', argv[i + 1]), '--temperature');
      i++;
      continue;
    }
    if (a === '--seed') {
      seed = parseIntStrict(need('--seed', argv[i + 1]), '--seed');
      i++;
      continue;
    }
    if (a === '--num-predict') {
      num_predict = parseIntStrict(need('--num-predict', argv[i + 1]), '--num-predict');
      i++;
      continue;
    }
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    throw new Error(`unknown flag: ${a}`);
  }

  if (trace_set === null) throw new Error('--trace-set required');

  return {
    accounts,
    classify_base_url,
    classify_model,
    draft_base_url,
    draft_model,
    trace_set,
    mode,
    out,
    run_tag,
    context_length,
    runtime_sha,
    quantization,
    temperature,
    seed,
    num_predict,
  };
}

// Strict numeric parsing — rejects partial-numeric strings ("4096abc").
function parseIntStrict(v: string, flag: string): number {
  const trimmed = v.trim();
  if (trimmed === '') throw new Error(`${flag} must be an integer, got: ${v}`);
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${flag} must be an integer, got: ${v}`);
  }
  return n;
}

function parseFloatStrict(v: string, flag: string): number {
  const trimmed = v.trim();
  if (trimmed === '') throw new Error(`${flag} must be a number, got: ${v}`);
  const n = Number(trimmed);
  if (!Number.isFinite(n)) throw new Error(`${flag} must be a number, got: ${v}`);
  return n;
}

// ── Inline trace-set loader (mirrors bake-off-harness ~30 LOC) ─────────
//
// Copied inline intentionally — bake-off-harness does not export this
// helper, and there's no second CLI consumer yet. If a third CLI needs
// the same logic, promote to lib/eval/trace-set-loader.ts.

interface TraceWithFilename {
  filename: string;
  trace: Trace;
}

interface LoadedTraceSet {
  traces: TraceWithFilename[];
  manifest_sha256: string;
  source_appliance: string;
  set_version: string;
}

async function loadTraceSetForBench(dir: string): Promise<LoadedTraceSet> {
  const manifestPath = path.join(dir, 'manifest.json');
  const manifestRaw = await readFile(manifestPath, 'utf-8');
  const manifest = traceManifestSchema.parse(JSON.parse(manifestRaw));
  const verdict = verifyManifest(manifest);
  if (!verdict.ok) {
    throw new Error(
      `trace-set manifest verification failed: ${verdict.reason}` +
        (verdict.expected !== undefined ? ` (expected=${verdict.expected})` : '') +
        (verdict.actual !== undefined ? ` (actual=${verdict.actual})` : ''),
    );
  }

  const onDisk = new Set((await readdir(dir)).filter((f) => f.endsWith('.trace.json')));
  for (const e of manifest.entries) {
    if (!onDisk.has(e.filename)) {
      throw new Error(`trace-set: manifest references missing file ${e.filename}`);
    }
  }

  const traces: TraceWithFilename[] = [];
  for (const e of manifest.entries) {
    const raw = await readFile(path.join(dir, e.filename), 'utf-8');
    traces.push({ filename: e.filename, trace: traceSchema.parse(JSON.parse(raw)) });
  }

  const manifest_sha256 = createHash('sha256').update(manifestRaw, 'utf-8').digest('hex');
  return {
    traces,
    manifest_sha256,
    source_appliance: manifest.source_appliance,
    set_version: manifest.set_version,
  };
}

// ── Verdict markdown formatter ─────────────────────────────────────────

function formatVerdictMd(
  results: ConcurrencyBenchResult[],
  runTag: string,
  traceSetDir: string,
): string {
  const lines: string[] = [];

  lines.push(`# S1 Verdict — ${runTag}`);
  lines.push('');
  lines.push(
    '**S1 gate (addendum §6 / DR-45):** classify p95 < 5000ms AND peak workload memory (Δ over baseline) ≤ 4.0 GiB',
  );
  lines.push(`**Trace set:** ${traceSetDir}`);
  lines.push('');
  lines.push(
    '| Mode | Classify p95 (ms) | Draft p95 (ms) | Baseline mem (GiB) | Peak mem (GiB) | Δ workload (GiB) | Verdict | Breaches |',
  );
  lines.push(
    '|------|-------------------|----------------|--------------------|----------------|------------------|---------|----------|',
  );

  for (const r of results) {
    const classifyP95 =
      r.overall_classify_p95_ms !== null ? r.overall_classify_p95_ms.toFixed(0) : 'n/a';
    const draftP95 = r.overall_draft_p95_ms !== null ? r.overall_draft_p95_ms.toFixed(0) : 'n/a';
    const baselineMem = r.baseline_mem_gib.toFixed(3);
    const peakMem = r.peak_mem_gib.toFixed(3);
    const workloadMem = r.peak_workload_mem_gib.toFixed(3);
    const verdictStr = r.verdict.verdict === 'pass' ? 'PASS' : 'FAIL';
    const breaches = r.verdict.verdict === 'fail' ? r.verdict.breaches.join(', ') : '';
    lines.push(
      `| ${r.mode} | ${classifyP95} | ${draftP95} | ${baselineMem} | ${peakMem} | ${workloadMem} | ${verdictStr} | ${breaches} |`,
    );
  }

  lines.push('');

  // DR-45 interpretation based on results.
  const serialized = results.find((r) => r.mode === 'serialized');
  const concurrent = results.find((r) => r.mode === 'concurrent');

  if (serialized !== undefined && concurrent !== undefined) {
    const serPass = serialized.verdict.verdict === 'pass';
    const conPass = concurrent.verdict.verdict === 'pass';
    let interpretation: string;
    if (serPass && conPass) {
      interpretation =
        'Serialized PASS + Concurrent PASS → DR-45: T2 supports multi-account concurrent mode; candidate for promotion.';
    } else if (serPass && !conPass) {
      interpretation =
        'Serialized PASS + Concurrent FAIL → DR-45 holds: T2 multi-account is serialized-only; concurrent mode is T3-first.';
    } else if (!serPass && conPass) {
      interpretation =
        'Serialized FAIL + Concurrent PASS → unexpected result; review methodology and re-run.';
    } else {
      interpretation =
        'Serialized FAIL + Concurrent FAIL → T2 multi-account support requires re-evaluation; may need account cap or T3-only.';
    }
    lines.push(`**DR-45 interpretation:** ${interpretation}`);
    lines.push('');
  }

  const overallVerdicts = results.map((r) => r.verdict.verdict);
  const anyFail = overallVerdicts.some((v) => v === 'fail');
  lines.push(anyFail ? '**Overall: S1 FAIL**' : '**Overall: S1 PASS**');
  lines.push('');
  lines.push('_Note: eval/results/ is gitignored. Do NOT commit this file._');

  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  console.log(
    `[concurrency-bench] accounts=${args.accounts} mode=${args.mode} ` +
      `classify=${args.classify_model}@${args.classify_base_url} ` +
      `draft=${args.draft_model}@${args.draft_base_url} ` +
      `trace-set=${args.trace_set}`,
  );

  // Load trace set.
  const loaded = await loadTraceSetForBench(args.trace_set);
  const tracesPerAccount = loaded.traces.map((t) => t.trace);
  console.log(
    `[concurrency-bench] loaded ${tracesPerAccount.length} traces ` +
      `(set=${loaded.set_version}, appliance=${loaded.source_appliance})`,
  );

  // Build shared endpoints. All N accounts replicate the same
  // classify + draft endpoints — S1 measures load shape, not per-account
  // model variation (noted here and in lib/eval/concurrency-bench.ts).
  const classifyEndpoint: ModelEndpoint = {
    model: args.classify_model,
    baseUrl: args.classify_base_url,
    quantization: args.quantization,
    context_length: args.context_length,
    runtime_sha: args.runtime_sha,
    gguf_sha256: null,
  };
  const draftEndpoint: ModelEndpoint = {
    model: args.draft_model,
    baseUrl: args.draft_base_url,
    quantization: args.quantization,
    context_length: args.context_length,
    runtime_sha: args.runtime_sha,
    gguf_sha256: null,
  };

  const accounts: AccountConfig[] = Array.from({ length: args.accounts }, (_, i) => ({
    account_id: `acct-${i}`,
    persona_label: `acct-${i}`,
    classifyEndpoint,
    draftEndpoint,
  }));

  // Determine which modes to run.
  const modesToRun: BenchMode[] = args.mode === 'both' ? ['serialized', 'concurrent'] : [args.mode];

  // Run each mode sequentially. The measurement itself may be concurrent
  // internally; we don't interleave modes to keep wall-clock readable.
  const results: ConcurrencyBenchResult[] = [];
  for (const mode of modesToRun) {
    console.log(`[concurrency-bench] running mode=${mode} …`);
    // No deps overrides — real classify fetch, real draft fetch, real
    // /proc/meminfo sampler, real clock/timers. Injection is for tests only.
    const result = await runConcurrencyBench(accounts, tracesPerAccount, mode);
    results.push(result);

    const v = result.verdict;
    const p95Str =
      result.overall_classify_p95_ms !== null
        ? `${result.overall_classify_p95_ms.toFixed(0)}ms`
        : 'n/a';
    const memStr =
      `peak=${result.peak_mem_gib.toFixed(3)} baseline=${result.baseline_mem_gib.toFixed(3)} ` +
      `Δworkload=${result.peak_workload_mem_gib.toFixed(3)} GiB`;
    const verdictStr = v.verdict === 'pass' ? 'PASS' : `FAIL(${v.breaches.join(',')})`;
    console.log(
      `[concurrency-bench] mode=${mode} classify_p95=${p95Str} ${memStr} verdict=${verdictStr}`,
    );
  }

  const finishedAt = new Date().toISOString();

  // Write outputs.
  await mkdir(args.out, { recursive: true });
  const summaryPath = path.join(args.out, `${args.run_tag}.summary.json`);
  const verdictPath = path.join(args.out, `${args.run_tag}.verdict.md`);

  const summaryPayload = {
    provenance: {
      run_tag: args.run_tag,
      started_at: startedAt,
      finished_at: finishedAt,
      accounts: args.accounts,
      trace_set_dir: args.trace_set,
      classify_model: args.classify_model,
      draft_model: args.draft_model,
      classify_base_url: args.classify_base_url,
      draft_base_url: args.draft_base_url,
      context_length: args.context_length,
      runtime_sha: args.runtime_sha,
      quantization: args.quantization,
      temperature: args.temperature,
      seed: args.seed,
    },
    results,
  };

  await writeFile(summaryPath, JSON.stringify(summaryPayload, null, 2));
  await writeFile(verdictPath, formatVerdictMd(results, args.run_tag, args.trace_set));

  console.log(`[concurrency-bench] done. summary=${summaryPath} verdict=${verdictPath}`);
  console.log(`[concurrency-bench] NOTE: eval/results/ is gitignored — do NOT commit these files.`);
}

// Direct execution check (vs `import`).
const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  main().catch((err) => {
    console.error('[concurrency-bench] FATAL:', err);
    process.exit(1);
  });
}
