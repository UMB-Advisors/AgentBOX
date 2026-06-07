# Nemotron Memory-Pressure Investigation — STAQPRO-342 follow-up

> **Run:** 2026-05-17 ~01:50 PDT
> **Hardware:** mailbox1 (Heron Labs production Jetson Orin Nano Super, 8 GB unified)
> **Image:** `local/llama-cpp:cuda-jetson-2026-05-16` (HEAD `4f13cb7`)
> **Model:** `NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf`
> **Prod state during probes:** llama-cpp + ollama stopped for the ~5 min investigation window; both restored after.

## TL;DR

**All 5 memory-reduction configs loaded cleanly and served prompts.** Including the same `--n-gpu-layers 99` config that crashed 100% of v1-v4 sweeps. **The real culprit was llama.cpp HEAD's default compute-buffer sizes** (`--batch-size 2048 --ubatch-size 512`), not the model itself or the KV cache.

With `--batch-size 512 --ubatch-size 128`, Nemotron survives full GPU offload on Orin 8GB.

## Configs tested

All share `--ctx-size 2048 --cache-type-k q4_0 --cache-type-v q4_0 --flash-attn on`. Variable dimension is GPU offload + batch sizing.

| # | Config | -ngl | KV loc | Batch / ubatch | 3-prompt time | t/s rough | Verdict |
|---|---|---|---|---|---|---|---|
| A | all-GPU + tight batch | **99** | GPU | **512 / 128** | **3371 ms** | **~14** | ✅ optimal |
| B | all-GPU + KV on CPU | 99 | CPU | 512 / 128 | 8383 ms | ~6 | works, ~2.5× slower |
| C | partial offload | 32 | GPU | 512 / 128 | 8228 ms | ~6 | works, ~2.4× slower |
| D | aggressive partial | 16 | GPU | 512 / 128 | 16602 ms | ~3 | works, ~5× slower |
| E | CPU-only | 0 | CPU | 512 / 128 | 33011 ms | ~1.5 | works, ~10× slower |

## Why this changes the bake-off

The full bake-off (`docs/plan-staqpro-342-bakeoff-v0_1-2026-05-16.md`) used the prod compose's batch defaults (effectively llama.cpp's defaults: 2048/512). That caused six kernel OOM-kills across v1-v4 and blocked all data collection on C1 + C2.

**With config A as the new baseline, a re-sweep of C1 + C2 should complete clean 100-trace runs** at full GPU performance. The bake-off's strategic question — Mamba/PLE/SFT2026 vs Qwen3 baseline — becomes answerable.

## Recommended re-run config

For the C1 + C2 re-sweep:
```
docker run --rm --runtime nvidia \
  -v .../llama-cpp-models:/models:ro -p 8080:8080 \
  --entrypoint /usr/local/bin/llama-server \
  local/llama-cpp:cuda-jetson-2026-05-16 \
  --model /models/<candidate>.gguf \
  --ctx-size 2048 --flash-attn on \
  --cache-type-k q4_0 --cache-type-v q4_0 \
  --batch-size 512 --ubatch-size 128 \
  --n-gpu-layers 99 \
  --host 0.0.0.0 --port 8080
```

Two methodology notes:
- The bake-off-harness already passes `--num-predict 256`; keep that.
- `--ctx-size 2048` (vs prod's 4096) means traces with inbox bodies > 2K tokens will get truncated by llama.cpp. Most of M1's v1.1 traces fit, but worst-case traces will fail. Acceptable for fair comparison since all candidates would hit the same cap.

## Why the prod compose has been stable on the OLD binary

Prod runs `local/llama-cpp:cuda-jetson` (= dustynv `b5283`, May 2025). That binary's default batch sizes are smaller than HEAD's, and its compute-buffer allocator is leaner. Same args (`-b` / `-ub` unspecified) = different memory profile. **Worth tracking upstream as a regression-vs-mitigation story**: HEAD made flash-attn more accurate but raised the default working-set size in ways that hit small-RAM systems.

## What this does NOT settle

- Function-call validity, blind-pref quality, real bake-off ranking for C1 + C2 — needs the re-sweep with config A
- Whether config A's tighter batches change per-token quality (theoretically shouldn't; batch size affects only throughput / parallelism, not the decoded distribution)
- Whether C3 Gemma 4 E4B would also unblock under config A — its OOM was at compute-graph reserve, similar pattern; worth one probe but not in this investigation's scope

## Provenance

Investigation log raw output: `mailbox1:/tmp/nemotron-offload-experiment.log` (operator-side, not committed). Distilled findings in this doc.

Branch `dustin/staqpro-342`, expected commit alongside this doc.

## Open question

The 14 t/s for Nemotron at config A is **below** the DR-21 gate's `≥ 15 t/s` requirement. This is from a 3-prompt micro-smoke, not a 100-trace run, so the average may shift either way. The bake-off's real-trace numbers will be definitive — Ctrl-A measured 16.0 t/s and Ctrl-B 15.4 t/s on the v2 100-trace run, so 14 t/s on 3 prompts maps roughly to Nemotron underperforming by ~10% on throughput. If confirmed at scale, gate 3 (≥15 t/s) becomes a real question for Nemotron even after the OOM is solved.

---

# v5 cfgA re-sweep — 2026-05-17 10:00–11:00 PDT

**Run:** post-investigation re-sweep on mailbox1, ctx-size dropped to 2048 per the investigation's recommendation, runtime image `local/llama-cpp:cuda-jetson-2026-05-16` (sha `4f13cb7`), prod `llama-cpp` + `ollama` stopped during carve-out, restored after.

## TL;DR

**Config A loads cleanly. It does not survive sustained inference.** Both C1 (Nemotron) and C2 (Qwen3.5-4B) kernel-OOM-killed under continuous 359-trace sweeps even with prod services down. Smoke ≠ sweep. The 8 GB unified-memory envelope on M1 is the binding constraint, not llama.cpp's default batch sizes — those were a necessary but not sufficient fix.

## Results

| Run | Model | ok / total | mean t/s | fc_success | p50 / p95 latency | OOMKilled |
|---|---|---|---|---|---|---|
| `eval-v5-cfgA-nemotron-3-nano-4b-2026-05-17` | C1 Nemotron 3 Nano 4B | 9 / 359 (2.5%) | **18.6** | **1.000** | 14.5 / 16.9 s | ✅ ExitCode 137 |
| `eval-v5-cfgA-slots-nemotron-probe-2026-05-17` | C1 + `--slots --parallel 2` | 10 / 20 (50%) | 18.3 | 1.000 | 13.4 / 17.6 s | ✅ ExitCode 137 |
| `eval-v5-cfgA-qwen3.5-4b-2026-05-17` | C2 Qwen3.5-4B | 13 / 359 (3.6%) | 14.8 (**below gate**) | **0.000** | 35.8 / 38.4 s | ✅ ExitCode 137 |
| v2 Ctrl-A (reference) | `qwen3:4b-ctx4k` | 59 / 100 (59%) | 16.0 | 0.339 | 16.3 / 22.4 s | ❌ |
| v2 Ctrl-B (reference) | `qwen3-4b-instruct-2507` | 49 / 100 (49%) | 15.4 | 0.735 | 10.2 / 21.9 s | ❌ |

Headline reads on the partial data:
- **Nemotron** throughput is *above* gate 3 (18.6 t/s) when it runs, AND fc_success was 1.000 on the 9 completing traces — actually the best fc-success across any candidate or control. But it dies after ~9-10 traces, so we cannot offer a population number that would satisfy any of gates 1-2.
- **Qwen3.5-4B** is *below* gate 3 (14.8 t/s) AND fc_success was 0.000 on its 13 completing traces. Worst-case across the board.
- Both candidates fail DR-21 gate 4 (≤ 3.4 GiB at 4K) — peak `anon-rss` at OOM time was 3.5 GiB at `ctx-size 2048`, which means scaling to 4K will be worse, not better.

## Root cause — 8 GB unified is the binding limit

Three OOM-kill events captured in `dmesg` across the v5 attempts (10:03:32, 10:19:43, ~10:50). All `oom-kill:constraint=CONSTRAINT_NONE` (global, not cgroup), all hit `llama-server` at 3.5-3.6 GiB `anon-rss` and 44-46 GiB `total-vm` (mmap'd weights).

Steady-state at-load measurements on the otherwise-quiescent Jetson (prod `llama-cpp` and `ollama` both stopped, `postgres`/`n8n`/`qdrant`/`mailbox-dashboard`/`caddy` still up):

| State | `MemAvailable` | `SwapFree` |
|---|---|---|
| Baseline before any candidate boot | 4923 MB | 3165 MB |
| Nemotron loaded, idle | 2631 MB | 3162 MB |
| Qwen3.5-4B loaded, idle | 2177 MB | 3119 MB |

So 4B-class transformers at Q4_K_M with config A + flash-attn + q4_0 KV at ctx 2048 take ~2.3 GiB to 2.7 GiB out of available headroom on top of the 8-service operational stack (`postgres`, `n8n`, `qdrant`, `mailbox-dashboard`, `caddy`, plus Docker daemon and the OS). KV growth + inference scratch over a sustained sweep crosses the OOM threshold within 10-15 traces.

The investigation's TL;DR ("config A unblocks Nemotron on Orin 8 GB") was correct for *load* and for a *3-prompt smoke*, but not for *sustained inference under realistic concurrent services*. The OOM root-cause headline shifts from "llama.cpp HEAD's default batch sizes" to **"4B-class transformer at sustained inference exceeds the 8 GB envelope when the operational stack is co-resident"**.

## Why baselines survive and these don't

The v2 Ctrl-A and Ctrl-B sweeps completed 100 traces against the same 8-service stack (prod fully running). Both are `qwen3-4b-instruct` family at Q4_K_M, ~2.4-2.7 GiB resident. The two new candidates are larger:

- C1 Nemotron 3 Nano 4B — 3.97B params (slightly heavier than baseline)
- C2 Qwen3.5-4B — 5B params (substantially heavier than baseline; multimodal weights paid for in memory but unused)

The candidate-set memo (`docs/plan-staqpro-342-bakeoff-v0_1-2026-05-16.md` Candidate set table) called this out as "may be tight on §3.5 envelope" for C2 and "Mamba KV-light" for C1 (which is partially true — but it didn't carry through to the per-request scratch). v5 establishes the empirical answer: **not tight, no-go on a 24/7 prod box.**

## Operational gotchas captured

- **Prod `llama-cpp` compose has `restart: unless-stopped`.** `docker compose stop llama-cpp` is silently reversed by a separate event (the dashboard or n8n probing the service, presumably). The first v5-nemotron OOM was *caused* by prod auto-restarting in parallel with the candidate. Mitigation used here: `docker update --restart=no mailbox-llama-cpp-1` before stop. Same applies to `mailbox-ollama-1`. Add to the bake-off Phase 3 runbook.
- **`--parallel 2` divides `--ctx-size` per slot.** Booting with `--ctx-size 2048 --parallel 2` gives each slot a 1024-token effective context. The 20-trace probe logged ~20 `request (1379 tokens) exceeds the available context size (1024 tokens), try increasing it` errors before the OOM took the container. If `--slots --parallel N` is kept, set `--ctx-size N*<desired_per_slot_ctx>`. Document or drop the flag — prod's `--slots --parallel 2` runs at `--ctx-size 4096` which gives 2048/slot.
- **Trace set v1.1 holds 359 traces, not 100.** v2 runs were `--limit 100`; v5 ran the full set unintentionally. Doesn't change the verdict but the run-tag scheme should make trace-count explicit going forward.

## DR-21 verdict (provisional, pending full bake-off)

Against the gate (1: fc ≥ baseline, 2: blind-pref ≥ 50%, 3: ≥ 15 t/s, 4: ≤ 3.4 GiB at 4K, 5: license clear, 6: no new tooling friction):

| Candidate | Gate 1 fc | Gate 3 t/s | Gate 4 memory | Gate 6 friction | Net |
|---|---|---|---|---|---|
| C1 Nemotron 3 Nano 4B | ✅ 1.000 (n=9) | ✅ 18.6 (n=9) | ❌ OOM at ctx-2048 | ❌ requires aggressive carve-out + restart-policy override + ulimit work | ❌ FAIL |
| C2 Qwen3.5-4B | ❌ 0.000 (n=13) | ❌ 14.8 (n=13) | ❌ OOM at ctx-2048 | ❌ same | ❌ FAIL |

**Recommendation for Phase 3:** do NOT proceed to blind-pref scoring on either candidate against the current 8 GB hardware. Two paths forward:

1. **Stay on the Ctrl-A/Ctrl-B floor.** `qwen3-4b-instruct-2507` (the live DR-25 baseline) already passes gates 1, 3, 4, 6 cleanly on the production stack — STAQPRO-342 closes with a "no winner found in this candidate set; keep DR-25 baseline" outcome and STAQPRO-344's LoRA work targets `qwen3-4b-instruct-2507`. C3 Gemma 4 E4B (PLE architecture, ~3.0 GB claimed) is the remaining unrun candidate; worth a smoke-only probe to confirm same OOM pattern before declaring the set exhausted.
2. **Re-scope DR-21 gate 4.** If Nemotron's fc=1.000 / t/s=18.6 on the n=9 successes is too tantalizing to abandon, the path is hardware: M5 production box (≥16 GB unified) per the M5 roadmap. This is a Phase 3 deferral, not a Phase 3 completion.

## What this does NOT settle

- C3 Gemma 4 E4B not probed. Plan said "skip if tooling unstable" — the GGUF is present on M1 (`gemma-4-E4B-it-Q4_K_M.gguf`), tooling presumed stable since llama.cpp HEAD parses Gemma 4. One smoke-only probe is < 10 minutes and would close the candidate-set audit. Out of scope for this v5 window.
- Whether Nemotron's fc=1.000 / t/s=18.6 holds on a larger sample. n=9 is too small to publish as a comparison; documented as suggestive only.
- Whether a more aggressive prod-side carve-out (stopping `qdrant` + `n8n` + `mailbox-dashboard` during the sweep, then restoring) would let either candidate complete 359 traces. Plan called for "stop prod llama.cpp during the sweep window"; v5 also stopped ollama; further would be 4+ stopped services and is operationally untenable for any production appliance test.

## Carve-out tear-down log

- v5-nemotron container: `docker rm -f v5-nemotron` (twice — `--rm` removed the first attempt; second was persistent for log capture)
- v5-qwen35 container: `docker rm -f v5-qwen35`
- Prod restored: `docker update --restart=unless-stopped mailbox-llama-cpp-1; docker compose up -d ollama llama-cpp`
- Verified post-restore: llama-cpp `/health=ok`, ollama healthy, classify lag `unclassified_24h=0`, drafts queue drained.

## Provenance

Summary JSONs:
- `eval-v5-cfgA-nemotron-3-nano-4b-2026-05-17.summary.json`
- `eval-v5-cfgA-slots-nemotron-probe-2026-05-17.summary.json`
- `eval-v5-cfgA-qwen3.5-4b-2026-05-17.summary.json`

Per-trace JSONLs same prefix, `.jsonl`. All under `dashboard/eval/results/bake-off-2026-05/` (gitignored; this addendum is the committed summary).

Carve-out window: 2026-05-17 ~10:00-11:00 PDT (~60 min). Prod drafting queue depth at start: 7 pending. Queue drained within ~10 min of restoring prod.
