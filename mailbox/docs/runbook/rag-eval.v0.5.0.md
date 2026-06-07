# RAG Eval Runbook v0.5.0

**Status:** v0.5.0 — adds the STAQPRO-340 trace-set workflow + perf-metrics + run-tagging on top of v0.4.0 (H5 score-floor sweep + H3 same-thread-suppression A/B). Everything in v0.4.0 still applies for tuning sweeps; this version adds the bake-off-friendly modes the model-comparison work needs.

**Audience:** Operator preparing the v1.0 trace set + running baseline / bake-off evaluations against it.

**Tracks:** STAQPRO-340 (eval harness + trace set v1.0). Parent: STAQPRO-336.

**What changed since v0.4.0:**

- New `--trace-set <dir>` flag on `dashboard/scripts/rag-eval-harness.ts` — load from a committed trace set instead of `mailbox.sent_history`.
- New `--run-tag <tag>` flag — explicit `eval-{model}-{date}` tagging; the bake-off uses this for cross-model aggregation.
- New `dashboard/scripts/build-trace-set.ts` — exports a SHA-pinned trace set from a live appliance.
- Per-pair perf metrics in the report JSON: `latency_ms`, `tokens_in`, `tokens_out`, `tokens_per_second`. Aggregates: `latency_ms_aggregates`, `tokens_in_aggregates`, `tokens_out_aggregates`, `tokens_per_second_aggregates`.
- New optional report fields: `run_tag`, `trace_set` provenance block.

Read v0.4.0 first if you've never run the eval before; this revision only documents the deltas.

---

## Generate v1.0 trace set

The trace set is **operator-local**. `*.trace.json` and the real `manifest.json` are gitignored under `dashboard/eval/`. The build script regenerates them from the live appliance DB.

```bash
# 1. SSH tunnel to mailbox1 Postgres (or mailbox2 — point --appliance accordingly)
ssh -L 5432:localhost:5432 mailbox1 -N &
TUNNEL_PID=$!

# 2. Read appliance Postgres password from 1Password
APPLIANCE_PASSWORD=$(op item get 'mailbox1' --vault MailBOX --reveal --fields password)

# 3. Run the build script. --extracted-at lets you produce byte-identical
#    re-runs if you need to (e.g., to verify a manifest hasn't drifted).
cd dashboard
POSTGRES_URL="postgresql://mailbox:${APPLIANCE_PASSWORD}@localhost:5432/mailbox" \
  npx tsx scripts/build-trace-set.ts \
    --out eval/t2-traces/v1.0 \
    --set-version v1.0 \
    --appliance mailbox1 \
    --limit 50 \
    --clean

# 4. Tear down tunnel
kill $TUNNEL_PID
```

The script prints `set_sha256=<hex>` on success — that's the content-address for the entire set. Cite it in any Linear comment / PR body that references the corpus.

**`--dry-run`** prints what would be written without touching disk. Useful for verifying the SQL pulls the rows you expect before clobbering an existing set.

**`--clean`** removes prior `*.trace.json` files in `--out` before writing the new set. Off by default to prevent surprise data loss.

---

## Run the eval against a committed trace set

```bash
cd dashboard
OLLAMA_BASE_URL=http://ollama:11434 \
QDRANT_URL=http://qdrant:6333 \
  npx tsx scripts/rag-eval-harness.ts \
    --trace-set eval/t2-traces/v1.0 \
    --judge=haiku \
    --run-tag eval-qwen3-4b-ctx4k-2026-05-13-baseline
```

What this does:

1. Loads `manifest.json` from `--trace-set <dir>`, parses with zod, verifies `set_sha256` against re-computed entries hash. **Refuses to run on a tampered set.**
2. Reads each `*.trace.json` listed in the manifest, verifies per-file SHA-256.
3. Runs the standard scorePair loop (cosine + judge + perf-metrics) just like the DB-driven path — only the source changed.
4. Writes the report to `dashboard/eval-results/rag-eval-<ts>-with-rag-judge-haiku-<run-tag>.json`.

The `--run-tag` is appended to the filename so `eval-results/eval-qwen3-4b-*.json` globs cleanly for cross-model bake-off aggregation.

**POSTGRES_URL is NOT required** in trace-set mode. The harness only needs DB connectivity when reading from `mailbox.sent_history` (the v0.4.0-and-earlier default).

`--limit` still works in trace-set mode — useful for quick smoke runs (`--limit 5`) against a large committed set without paying for the full eval.

---

## Bake-off pattern (STAQPRO-342)

Three model variants against the same trace set:

```bash
TRACE=eval/t2-traces/v1.0
DATE=2026-05-20

# Variant A — current baseline
RAG_EVAL_DRAFTER_MODEL=qwen3:4b-ctx4k \
  npx tsx scripts/rag-eval-harness.ts --trace-set $TRACE --judge=haiku \
    --run-tag eval-qwen3-4b-ctx4k-$DATE

# Variant B — Nemotron 3 Nano 4B
RAG_EVAL_DRAFTER_MODEL=nemotron3-nano-4b \
  npx tsx scripts/rag-eval-harness.ts --trace-set $TRACE --judge=haiku \
    --run-tag eval-nemotron3-nano-4b-$DATE

# Variant C — Gemma 4 E4B
RAG_EVAL_DRAFTER_MODEL=gemma4-e4b \
  npx tsx scripts/rag-eval-harness.ts --trace-set $TRACE --judge=haiku \
    --run-tag eval-gemma4-e4b-$DATE
```

(Each variant requires the host Ollama / llama.cpp instance to already serve the named model. STAQPRO-338 / STAQPRO-339 land that — the bake-off can't run until those do.)

All three reports share the same `trace_set.set_sha256` — the bake-off's first sanity check is asserting that. Per-model `tokens_per_second_aggregates.mean` and `judge_aggregates_global.mean` are the two numbers that decide DR-21.

---

## Reading the perf metrics

The harness summary now prints a `Perf metrics` block when at least one pair captured Ollama-shape metrics:

```
Perf metrics (run_tag=eval-qwen3-4b-ctx4k-2026-05-13-baseline):
  tokens/sec       count=  47  mean=22.41  median=22.85  p25=20.10  p75=24.30
  latency_ms       count=  47  mean=4280   median=4150   p25=3820   p75=4710
  tokens_in        count=  47  mean=612    median=580
  tokens_out       count=  47  mean=95     median=89
```

- **`tokens_per_second`** = `eval_count / (eval_duration_ns / 1e9)`. Source: Ollama `/api/chat` response fields. DR-21 gate: ≥ 15.
- **`latency_ms`** = wall-clock around the `fetch` + JSON read. Includes network + queue + inference + serialize. Always captured (even on cloud endpoints that don't emit `eval_count`).
- **`tokens_in`** / **`tokens_out`** = direct from `prompt_eval_count` / `eval_count`.

On cloud endpoints (Anthropic via Ollama-shape adapter, Ollama Cloud `gpt-oss:120b`) the token counters may be absent. The aggregate count drops to 0 for those metrics on a cloud-only run; `latency_ms` still aggregates normally.

**Peak GPU memory is NOT captured by the harness.** Run `nvidia-smi --query-gpu=memory.used --loop-ms=500` (or `tegrastats` on Jetson) in parallel to the eval and capture the max manually. This is intentional: the harness is workstation-portable, and `nvidia-smi` polling from inside the dashboard container is finicky across docker/nvidia-runtime combinations.

---

## Backward compatibility

The DB-driven path is unchanged. v0.4.0 sweep commands (H5/H3) keep working — they don't touch any of the new flags. Reports generated without `--trace-set` carry no `trace_set` field; reports generated without `--run-tag` carry a derived `eval-<safe-model>-<YYYY-MM-DD>` value (and the filename suffix derives from it).

The report JSON has new optional fields (`run_tag`, `trace_set`, perf aggregates) — any downstream consumer that did `JSON.parse(report)` and only read the known fields keeps working.

---

## Privacy reminder

Same as v0.4.0 — judge calls send draft + reply bytes to the chosen cloud provider. The trace set itself never leaves the operator workstation (gitignored).
