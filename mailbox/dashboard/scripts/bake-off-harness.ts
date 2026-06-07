#!/usr/bin/env -S npx tsx

// dashboard/scripts/bake-off-harness.ts
//
// STAQPRO-342 — bake-off harness CLI. Hits a llama.cpp HTTP endpoint with
// a frozen prompt envelope for each trace in a trace-set directory and
// emits a per-trace JSONL + a summary.json with aggregates + provenance.
//
// Usage (smoke run against a local llama.cpp):
//   POSTGRES_URL=unused npx tsx scripts/bake-off-harness.ts \
//     --model qwen3-4b-ctx4k \
//     --base-url http://localhost:8080 \
//     --trace-set eval/t2-traces/v1.0 \
//     --run-tag eval-qwen3-4b-2026-05-16 \
//     --out eval/results/bake-off-2026-05 \
//     --quantization Q4_K_M \
//     --context-length 4096 \
//     --runtime-sha llamacpp-abc123 \
//     --limit 5
//
// One full sweep run (operator workflow, Phase 3):
//   For each candidate in {nemotron, qwen3.5-4b, gemma4-e4b, qwen3-2507}:
//     1. Stop prod llama.cpp; boot candidate llama.cpp on M1 port 8080
//     2. From operator workstation:
//          npx tsx scripts/bake-off-harness.ts --model <cand> \
//            --base-url http://192.168.50.179:8080 \
//            --trace-set eval/t2-traces/v1.0 \
//            --run-tag eval-<cand>-$(date +%Y-%m-%d) \
//            --out eval/results/bake-off-2026-05
//        + repeat for --trace-set eval/t2-traces/v1.1
//     3. Shut down candidate llama.cpp; loop.
//   After all candidates: restart prod llama.cpp; verify classify lag green.
//
// Output:
//   {out}/{run-tag}.jsonl           — one BakeOffPerTraceResult per line
//   {out}/{run-tag}.summary.json    — { provenance, aggregates }
//
// Privacy: JSONL contains PII-scrubbed reply bytes and model outputs.
// Treat the same as `dashboard/eval/results/` (gitignored).

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  aggregateBakeOffResults,
  type BakeOffPerTraceResult,
  type BakeOffPrompt,
  type BakeOffRunProvenance,
  type ChatMessage,
  type ModelEndpoint,
  runBakeOffOnTrace,
} from '../lib/eval/bake-off';
import {
  type Trace,
  traceManifestSchema,
  traceSchema,
  verifyManifest,
} from '../lib/eval/trace-set';

// ── Args ──────────────────────────────────────────────────────────────

interface CliArgs {
  model: string;
  base_url: string;
  trace_set: string;
  run_tag: string;
  out: string;
  quantization: string;
  context_length: number;
  runtime_sha: string;
  gguf_sha256: string | null;
  /** Limit traces (-1 = all). Default = all. */
  limit: number;
  /** Temperature; default 0 for deterministic comparison. */
  temperature: number;
  /** Seed; default 42 (pinned). */
  seed: number;
  /** Max output tokens; default 512 (drafter target). */
  num_predict: number;
  /** If true, prompt is a JSON-envelope drafter; if false, free-text. */
  expect_function_call: boolean;
  /** If true, allow truncating an existing {run-tag}.jsonl. Default false:
   *  a collision throws so a prior run's results aren't silently clobbered. */
  overwrite: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  // Defaults
  let model: string | null = null;
  let base_url: string | null = null;
  let trace_set: string | null = null;
  let run_tag: string | null = null;
  let out: string | null = null;
  let quantization = 'Q4_K_M';
  let context_length = 4096;
  let runtime_sha = 'unknown';
  let gguf_sha256: string | null = null;
  let limit = -1;
  let temperature = 0;
  let seed = 42;
  let num_predict = 512;
  let expect_function_call = true;
  let overwrite = false;

  const need = (flag: string, v: string | undefined): string => {
    if (v === undefined || v === '') throw new Error(`${flag} requires a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--model') {
      model = need('--model', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--base-url') {
      base_url = need('--base-url', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--trace-set') {
      trace_set = need('--trace-set', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--run-tag') {
      run_tag = need('--run-tag', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--out') {
      out = need('--out', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--quantization') {
      quantization = need('--quantization', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--context-length') {
      const v = need('--context-length', argv[i + 1]);
      context_length = parseIntStrict(v, '--context-length');
      i++;
      continue;
    }
    if (a === '--runtime-sha') {
      runtime_sha = need('--runtime-sha', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--gguf-sha256') {
      gguf_sha256 = need('--gguf-sha256', argv[i + 1]);
      i++;
      continue;
    }
    if (a === '--limit') {
      const v = need('--limit', argv[i + 1]);
      limit = v === 'all' ? -1 : parseIntStrict(v, '--limit');
      i++;
      continue;
    }
    if (a === '--temperature') {
      const v = need('--temperature', argv[i + 1]);
      temperature = parseFloatStrict(v, '--temperature');
      i++;
      continue;
    }
    if (a === '--seed') {
      const v = need('--seed', argv[i + 1]);
      seed = parseIntStrict(v, '--seed');
      i++;
      continue;
    }
    if (a === '--num-predict') {
      const v = need('--num-predict', argv[i + 1]);
      num_predict = parseIntStrict(v, '--num-predict');
      i++;
      continue;
    }
    if (a === '--free-text') {
      expect_function_call = false;
      continue;
    }
    if (a === '--overwrite') {
      overwrite = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    throw new Error(`unknown flag: ${a}`);
  }

  if (model === null) throw new Error('--model required');
  if (base_url === null) throw new Error('--base-url required');
  if (trace_set === null) throw new Error('--trace-set required');
  if (run_tag === null) throw new Error('--run-tag required');
  if (out === null) throw new Error('--out required');

  return {
    model,
    base_url,
    trace_set,
    run_tag,
    out,
    quantization,
    context_length,
    runtime_sha,
    gguf_sha256,
    limit,
    temperature,
    seed,
    num_predict,
    expect_function_call,
    overwrite,
  };
}

// Strict numeric parsing — rejects partial-numeric strings like "4096abc"
// that Number.parseInt would silently truncate to 4096. Number(v) returns NaN
// on any trailing garbage; the empty-string guard prevents Number('') from
// passing as 0.
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

const USAGE = `bake-off-harness — STAQPRO-342 three-way T2 model bake-off

Required:
  --model <tag>              Model name sent to llama.cpp's /v1/chat/completions
  --base-url <url>           llama.cpp server base URL
  --trace-set <dir>          Trace-set directory (must contain manifest.json + *.trace.json)
  --run-tag <tag>            Output filename prefix (e.g. eval-nemotron-2026-05-16)
  --out <dir>                Output directory (will be created)

Provenance (recommended for reproducibility):
  --quantization <q>         Default Q4_K_M
  --context-length <n>       Default 4096
  --runtime-sha <sha>        llama.cpp git SHA at server start
  --gguf-sha256 <sha>        SHA-256 of the GGUF file on disk

Decoding (pinned for fair comparison):
  --temperature <f>          Default 0 (deterministic)
  --seed <n>                 Default 42
  --num-predict <n>          Default 512

Run-shape:
  --limit <n|all>            Cap traces for smoke (default all)
  --free-text                Disable function-call validity check (default: JSON envelope expected)
  --overwrite                Allow truncating an existing {run-tag}.jsonl (default: error on collision)
`;

// ── Output-collision guard (MBOX-113) ─────────────────────────────────
//
// `writeFile(jsonlPath, '')` truncates a prior run's JSONL silently when a
// --run-tag collides. Guard it: error by default (suggesting a unique tag),
// truncate only when the operator passes --overwrite. Exported for testing.

export async function assertJsonlNotClobbered(
  jsonlPath: string,
  runTag: string,
  overwrite: boolean,
): Promise<void> {
  let exists = false;
  try {
    await access(jsonlPath, fsConstants.F_OK);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists) return;
  if (overwrite) {
    console.error(
      `[bake-off] WARNING: overwriting existing ${jsonlPath} (--overwrite). ` +
        'Prior run results for this tag are lost.',
    );
    return;
  }
  throw new Error(
    `[bake-off] refusing to clobber existing output ${jsonlPath} for --run-tag "${runTag}". ` +
      'Use a unique --run-tag (e.g. append a timestamp) or pass --overwrite to truncate it.',
  );
}

// ── Inline trace-set loader (~30 LOC; no second consumer yet) ─────────

interface TraceWithFilename {
  filename: string;
  trace: Trace;
}
interface LoadedTraceSet {
  traces: TraceWithFilename[];
  manifest_sha256: string;
  /** Source appliance per manifest (e.g., `mailbox1`). */
  source_appliance: string;
  /** Trace-set version per manifest (e.g., `v1.0`). */
  set_version: string;
}

async function loadTraceSetForBakeOff(dir: string): Promise<LoadedTraceSet> {
  const manifestPath = path.join(dir, 'manifest.json');
  const manifestRaw = await readFile(manifestPath, 'utf-8');
  const manifest = traceManifestSchema.parse(JSON.parse(manifestRaw));
  const verdict = verifyManifest(manifest);
  if (!verdict.ok) {
    throw new Error(
      `trace-set manifest verification failed: ${verdict.reason} (expected=${verdict.expected ?? 'n/a'}, actual=${verdict.actual ?? 'n/a'})`,
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

// ── Frozen minimal-drafter prompt (v0.1, STAQPRO-342) ─────────────────
//
// Snapshot of a representative drafter prompt for the bake-off. The
// prompt is intentionally small and explicit about the JSON envelope so
// candidates are scored on their ability to follow a clear function-call
// contract. The production drafter's full prompt (persona + RAG +
// thread-history) is bigger; that comparison happens in Phase 5 as a
// follow-up sweep against the winner from this minimal-prompt round.
//
// To pin: this assembler's provenance is the explicit
// `BAKEOFF_PROMPT_SNAPSHOT_TAG` below. Bump it whenever the prompt's
// SEMANTICS change (system/user content, envelope contract, decoding
// shape). Do NOT derive provenance from the function source bytes — that
// churns under transpiler/whitespace changes with no semantic delta and
// produces spurious "prompt changed" provenance diffs across re-runs
// (MBOX-113). The tag is the single source of truth the operator controls.

const BAKEOFF_PROMPT_SNAPSHOT_TAG = 'bake-off-minimal-drafter-v0.1-2026-05-16';

function assembleMinimalDrafterPrompt(
  trace: Trace,
  options: { temperature: number; seed: number; num_predict: number },
): BakeOffPrompt {
  const system: ChatMessage = {
    role: 'system',
    content: [
      'You are a small-business operator drafting replies to inbound email.',
      'Read the inbound email and write a single reply.',
      'Respond ONLY with a JSON object in this exact shape:',
      '{ "body": "<your reply, plain text>", "subject": "<optional re: subject>" }',
      'No prose before or after the JSON. No code fences. No commentary.',
      "Tone: professional, friendly, concise. Match the inbound's register.",
    ].join('\n'),
  };
  const user: ChatMessage = {
    role: 'user',
    content: [
      `From: ${trace.inbox_from ?? '(unknown)'}`,
      `Subject: ${trace.inbox_subject ?? '(no subject)'}`,
      '',
      trace.inbox_body,
    ].join('\n'),
  };
  return {
    messages: [system, user],
    options: {
      temperature: options.temperature,
      seed: options.seed,
      num_predict: options.num_predict,
    },
  };
}

function computePromptAssemblySha(): string {
  // Hash ONLY the explicit snapshot tag — stable across transpiler/
  // whitespace churn. Bump BAKEOFF_PROMPT_SNAPSHOT_TAG when the prompt
  // actually changes; the operator owns that signal (MBOX-113). Hashing
  // `assembleMinimalDrafterPrompt.toString()` was fragile: it changed the
  // recorded sha under no-semantic-change toolchain edits.
  return createHash('sha256').update(BAKEOFF_PROMPT_SNAPSHOT_TAG).digest('hex').slice(0, 16);
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  console.log(
    `[bake-off] model=${args.model} trace-set=${args.trace_set} run-tag=${args.run_tag} ` +
      `temp=${args.temperature} seed=${args.seed} fn-call=${args.expect_function_call}`,
  );

  const loaded = await loadTraceSetForBakeOff(args.trace_set);
  const traces = args.limit < 0 ? loaded.traces : loaded.traces.slice(0, args.limit);
  console.log(
    `[bake-off] loaded ${loaded.traces.length} traces (set=${loaded.set_version}, ` +
      `appliance=${loaded.source_appliance}); running ${traces.length}.`,
  );

  await mkdir(args.out, { recursive: true });
  const jsonlPath = path.join(args.out, `${args.run_tag}.jsonl`);
  const summaryPath = path.join(args.out, `${args.run_tag}.summary.json`);

  // Guard against silently clobbering a prior run's JSONL on a --run-tag
  // collision (MBOX-113). Truncate only when safe or --overwrite was passed.
  await assertJsonlNotClobbered(jsonlPath, args.run_tag, args.overwrite);
  await writeFile(jsonlPath, '');

  const endpoint: ModelEndpoint = {
    model: args.model,
    baseUrl: args.base_url,
    quantization: args.quantization,
    context_length: args.context_length,
    runtime_sha: args.runtime_sha,
    gguf_sha256: args.gguf_sha256,
  };

  const promptAssemblySha = computePromptAssemblySha();
  const results: BakeOffPerTraceResult[] = [];

  for (let i = 0; i < traces.length; i++) {
    const entry = traces[i];
    if (entry === undefined) continue;
    const { trace, filename } = entry;
    const prompt = assembleMinimalDrafterPrompt(trace, {
      temperature: args.temperature,
      seed: args.seed,
      num_predict: args.num_predict,
    });
    const result = await runBakeOffOnTrace(
      trace,
      filename,
      prompt,
      endpoint,
      args.expect_function_call,
    );
    results.push(result);
    await appendFile(jsonlPath, `${JSON.stringify(result)}\n`);
    if ((i + 1) % 10 === 0 || i === traces.length - 1) {
      const okSoFar = results.filter((r) => r.status === 'ok').length;
      console.log(
        `[bake-off] ${i + 1}/${traces.length} (ok=${okSoFar}, ` +
          `last_status=${result.status}, last_latency=${result.latency_ms}ms)`,
      );
    }
  }

  const finishedAt = new Date().toISOString();
  const okCount = results.filter((r) => r.status === 'ok').length;
  const provenance: BakeOffRunProvenance = {
    started_at: startedAt,
    finished_at: finishedAt,
    run_tag: args.run_tag,
    trace_set_dir: args.trace_set,
    trace_set_manifest_sha256: loaded.manifest_sha256,
    endpoint,
    prompt_assembly_sha: `${BAKEOFF_PROMPT_SNAPSHOT_TAG}:${promptAssemblySha}`,
    trace_count: traces.length,
    ok_count: okCount,
    error_count: traces.length - okCount,
  };
  const aggregates = aggregateBakeOffResults(results);
  await writeFile(summaryPath, JSON.stringify({ provenance, aggregates }, null, 2));

  console.log(`[bake-off] done. JSONL=${jsonlPath} summary=${summaryPath}`);
  console.log(
    `[bake-off] ok_rate=${aggregates.ok_rate.toFixed(3)} ` +
      `fc_success=${aggregates.function_call_success_rate?.toFixed(3) ?? 'n/a'} ` +
      `mean_tps=${aggregates.mean_tokens_per_second?.toFixed(1) ?? 'n/a'} ` +
      `p50=${aggregates.p50_latency_ms?.toFixed(0) ?? 'n/a'}ms ` +
      `p95=${aggregates.p95_latency_ms?.toFixed(0) ?? 'n/a'}ms`,
  );
}

// Direct execution check (vs `import`).
const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  main().catch((err) => {
    console.error('[bake-off] FATAL:', err);
    process.exit(1);
  });
}
