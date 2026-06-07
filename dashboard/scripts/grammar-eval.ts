#!/usr/bin/env -S npx tsx
// dashboard/scripts/grammar-eval.ts
//
// MBOX-120 — constrained-decoding A/B measurement harness.
//
// For each reorder/scheduling trace in a trace-set directory, calls the local
// drafter twice — once WITHOUT a grammar (baseline) and once WITH the GBNF
// grammar for the trace's category — and writes a side-by-side JSONL so a human
// (or a follow-up judge pass) can blind-compare. This script does NOT score
// quality: constrained decoding's risk is semantic degradation, which a
// mechanical metric can't reliably catch (arxiv 2603.03305). It measures only
// what it can measure objectively: latency and tokens/sec per arm, plus the raw
// outputs. Blind-preference / quality judgement is a deliberate human follow-up.
//
// Runs against the appliance's local Ollama (or the llama.cpp proxy) — the same
// /api/chat shape either way. Constrained decoding only actually bites on the
// llama.cpp runtime; against real Ollama the grammar is ignored, so the two
// arms will look identical there (expected — that's the control).
//
// Usage (from a workstation, against M1's dashboard llm proxy):
//   POSTGRES_URL=unused npx tsx scripts/grammar-eval.ts \
//     --trace-set eval/t2-traces/v1.0 \
//     --base-url http://192.168.50.179:3001/dashboard/api/internal/llm \
//     --model qwen3:4b-ctx4k \
//     --out eval/results/grammar-eval-2026-05-28 \
//     --run-tag grammar-eval-2026-05-28 \
//     --limit 10
//
// Output: {out}/{run-tag}.jsonl — one GrammarEvalResult per trace.
//
// Privacy: JSONL carries PII-scrubbed inbound bytes + model outputs. Treat the
// same as dashboard/eval/results/ (gitignored).

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Category } from '../lib/classification/prompt';
import { grammarForCategory } from '../lib/drafting/grammar-dispatch';
import { chat } from '../lib/drafting/ollama';
import {
  type Trace,
  traceManifestSchema,
  traceSchema,
  verifyManifest,
} from '../lib/eval/trace-set';

// Categories this harness evaluates — the constrained set.
const EVAL_CATEGORIES: ReadonlyArray<Category> = ['reorder', 'scheduling'];

interface CliArgs {
  trace_set: string;
  base_url: string;
  model: string;
  out: string;
  run_tag: string;
  api_key: string;
  /** Cap traces for a smoke run (-1 = all). */
  limit: number;
  temperature: number;
  max_tokens: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let trace_set: string | null = null;
  let base_url: string | null = null;
  let model = 'qwen3:4b-ctx4k';
  let out: string | null = null;
  let run_tag: string | null = null;
  let api_key = '';
  let limit = -1;
  let temperature = 0.7;
  let max_tokens = 600;

  const need = (flag: string, v: string | undefined): string => {
    if (v === undefined || v === '') throw new Error(`${flag} requires a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--trace-set') {
      trace_set = need('--trace-set', argv[i + 1]);
      i++;
    } else if (a === '--base-url') {
      base_url = need('--base-url', argv[i + 1]);
      i++;
    } else if (a === '--model') {
      model = need('--model', argv[i + 1]);
      i++;
    } else if (a === '--out') {
      out = need('--out', argv[i + 1]);
      i++;
    } else if (a === '--run-tag') {
      run_tag = need('--run-tag', argv[i + 1]);
      i++;
    } else if (a === '--api-key') {
      api_key = need('--api-key', argv[i + 1]);
      i++;
    } else if (a === '--limit') {
      const v = need('--limit', argv[i + 1]);
      limit = v === 'all' ? -1 : Number(v);
      i++;
    } else if (a === '--temperature') {
      temperature = Number(need('--temperature', argv[i + 1]));
      i++;
    } else if (a === '--max-tokens') {
      max_tokens = Number(need('--max-tokens', argv[i + 1]));
      i++;
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }

  if (trace_set === null) throw new Error('--trace-set required');
  if (base_url === null) throw new Error('--base-url required');
  if (out === null) throw new Error('--out required');
  if (run_tag === null) throw new Error('--run-tag required');

  return { trace_set, base_url, model, out, run_tag, api_key, limit, temperature, max_tokens };
}

// Per-arm measurement. No quality fields — those are a human/judge follow-up.
interface ArmMeasurement {
  output: string;
  input_tokens: number;
  output_tokens: number;
  eval_duration_ms: number | null;
  latency_ms: number;
  tokens_per_second: number | null;
  error: string | null;
}

interface GrammarEvalResult {
  trace_filename: string;
  inbox_message_id: string;
  category: string;
  baseline: ArmMeasurement;
  constrained: ArmMeasurement;
}

async function loadTraces(dir: string): Promise<{ filename: string; trace: Trace }[]> {
  const manifestRaw = await readFile(path.join(dir, 'manifest.json'), 'utf-8');
  const manifest = traceManifestSchema.parse(JSON.parse(manifestRaw));
  const verdict = verifyManifest(manifest);
  if (!verdict.ok) {
    throw new Error(`trace-set manifest verification failed: ${verdict.reason}`);
  }
  const onDisk = new Set((await readdir(dir)).filter((f) => f.endsWith('.trace.json')));
  const traces: { filename: string; trace: Trace }[] = [];
  for (const e of manifest.entries) {
    if (!onDisk.has(e.filename)) {
      throw new Error(`trace-set: manifest references missing file ${e.filename}`);
    }
    const raw = await readFile(path.join(dir, e.filename), 'utf-8');
    traces.push({ filename: e.filename, trace: traceSchema.parse(JSON.parse(raw)) });
  }
  return traces;
}

// One drafter call (one arm). Returns latency + tps alongside the raw output.
// Quality is intentionally NOT computed here.
async function runArm(
  args: CliArgs,
  trace: Trace,
  grammar: string | undefined,
): Promise<ArmMeasurement> {
  const messages = [
    {
      role: 'system' as const,
      content: 'You are a small-business operator drafting a reply to inbound email.',
    },
    {
      role: 'user' as const,
      content: [
        `From: ${trace.inbox_from ?? '(unknown)'}`,
        `Subject: ${trace.inbox_subject ?? '(no subject)'}`,
        '',
        trace.inbox_body,
      ].join('\n'),
    },
  ];
  const t0 = Date.now();
  try {
    const res = await chat({
      baseUrl: args.base_url,
      apiKey: args.api_key,
      model: args.model,
      messages,
      temperature: args.temperature,
      max_tokens: args.max_tokens,
      grammar,
    });
    const latency_ms = Date.now() - t0;
    const tokens_per_second =
      res.eval_duration_ms && res.eval_duration_ms > 0
        ? res.output_tokens / (res.eval_duration_ms / 1000)
        : null;
    return {
      output: res.body,
      input_tokens: res.input_tokens,
      output_tokens: res.output_tokens,
      eval_duration_ms: res.eval_duration_ms,
      latency_ms,
      tokens_per_second,
      error: null,
    };
  } catch (err) {
    return {
      output: '',
      input_tokens: 0,
      output_tokens: 0,
      eval_duration_ms: null,
      latency_ms: Date.now() - t0,
      tokens_per_second: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Force the flag on for the duration of this measurement run so
  // grammarForCategory yields the GBNF for the constrained arm regardless of
  // the appliance's live setting.
  process.env.CONSTRAINED_DECODING_ENABLED = '1';

  const all = await loadTraces(args.trace_set);
  const filtered = all.filter((t) =>
    EVAL_CATEGORIES.includes((t.trace.classification ?? '') as Category),
  );
  const traces = args.limit < 0 ? filtered : filtered.slice(0, args.limit);

  console.log(
    `[grammar-eval] loaded ${all.length} traces, ${filtered.length} in {reorder,scheduling}; running ${traces.length}.`,
  );

  await mkdir(args.out, { recursive: true });
  const jsonlPath = path.join(args.out, `${args.run_tag}.jsonl`);
  await writeFile(jsonlPath, '');

  const lines: string[] = [];
  for (let i = 0; i < traces.length; i++) {
    const entry = traces[i];
    if (entry === undefined) continue;
    const { trace, filename } = entry;
    const category = (trace.classification ?? '') as Category;
    const grammar = grammarForCategory(category) ?? undefined;

    // Baseline first (no grammar), then constrained (with grammar).
    const baseline = await runArm(args, trace, undefined);
    const constrained = await runArm(args, trace, grammar);

    const result: GrammarEvalResult = {
      trace_filename: filename,
      inbox_message_id: trace.inbox_message_id,
      category,
      baseline,
      constrained,
    };
    lines.push(JSON.stringify(result));
    console.log(
      `[grammar-eval] ${i + 1}/${traces.length} ${category} ` +
        `base=${baseline.latency_ms}ms/${baseline.tokens_per_second?.toFixed(1) ?? 'n/a'}tps ` +
        `constr=${constrained.latency_ms}ms/${constrained.tokens_per_second?.toFixed(1) ?? 'n/a'}tps ` +
        `${baseline.error || constrained.error ? '(ERR)' : ''}`,
    );
  }

  await writeFile(jsonlPath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  const setSha = createHash('sha256').update(args.trace_set).digest('hex').slice(0, 12);
  console.log(`[grammar-eval] done. JSONL=${jsonlPath} (n=${lines.length}, set=${setSha})`);
  console.log(
    '[grammar-eval] NOTE: this harness measures latency/tps + raw outputs only. ' +
      'Blind-preference / quality judgement is a human (or judge.ts) follow-up.',
  );
}

const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  main().catch((err) => {
    console.error('[grammar-eval] FATAL:', err);
    process.exit(1);
  });
}
