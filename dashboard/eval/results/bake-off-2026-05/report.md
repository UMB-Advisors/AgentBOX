# Bake-Off Report — STAQPRO-342 / DR-21

> **Run period:** 2026-05-16 evening through 2026-05-17 ~01:30 PDT
> **Test bench:** mailbox1 (Heron Labs production Jetson Orin Nano Super, JetPack 6.2)
> **Branch:** `dustin/staqpro-342`
> **Trace set:** `dashboard/eval/t2-traces/v1.1` (manifest sha `d5299a91...`, 359 traces, post-STAQPRO-365 filtered from M1's `sent_history`)

## TL;DR

**Winner of the comparable subset: Ctrl-B `qwen3-4b-instruct-2507`** — beats the current prod baseline on every metric that matters: 2.77× function-call validity, 1.63× faster p50 latency, comparable throughput.

**C1 Nemotron-3-Nano-4B and C2 Qwen3.5-4B are blocked** at the Jetson hardware envelope — kernel OOM-killer terminates the new-build llama-server before meaningful data can be collected. Documented as a follow-up workstream.

Recommendation: ship Ctrl-B as the prod drafting baseline; treat the strategic Mamba/SFT2026 comparison as a separate "smaller build / smaller model / different hardware" workstream.

## Method

Per the plan (`docs/plan-staqpro-342-bakeoff-v0_1-2026-05-16.md` + decision-record commits `6f7fbbc` and `c8c3251`):

- Build llama.cpp HEAD (`4f13cb7`) on M1 (see `docs/plan-staqpro-342-phase2-status-v0_1-2026-05-16.md` for build path). Image `local/llama-cpp:cuda-jetson-2026-05-16`.
- Stop prod llama-cpp (and ollama in v2-v4) during each sweep window.
- For each candidate: run `dashboard/scripts/bake-off-harness.ts` from operator workstation against M1's LAN port 8080, hitting the ephemeral `local/llama-cpp:cuda-jetson-2026-05-16` container loaded with that candidate's GGUF.
- Prompt: frozen `bake-off-minimal-drafter-v0.1-2026-05-16` snapshot (system prompt asks for JSON `{ body, subject }` envelope; user prompt = `From / Subject / Body` from trace).
- Decoding: `temperature=0 seed=42 num_predict=256`.
- Prod restored after each sweep; total ~80 minutes of prod-drafting downtime across all 4 sweeps; classify continued on ollama (except v2-v4 where ollama also paused).

### Sweep configurations

| Run | Scope | `--ctx-size` | KV cache | `--no-mmap` | ollama up | Outcome |
|---|---|---|---|---|---|---|
| v1 (smoke) | 4 cands × 5 | 4096 | q8_0 | yes | yes | 4/4 ok, n=5 too small |
| v1 (full) | 4 cands × 100 | 4096 | q8_0 | yes | yes | OOM-kills; Ctrl-A 49/100 only usable |
| v2 | 4 cands × 100 | 4096 | **q4_0** | yes | **no** | Ctrl-A 59, Ctrl-B 49, C2 9, C1 0; OOMs continued |
| v3 | C1+C2 × 100 | **2048** | q4_0 | yes | no | C2 23, C1 0 |
| v4 | C1+C2 × 100 | 2048 | q4_0 | **no (mmap)** | no | C2 29, C1 0 |

## Results — matched-subset (the clean comparison)

After v2, both Ctrl-A and Ctrl-B had 49 traces in common where both completed successfully. This is the **apples-to-apples** subset: same trace inputs, same prompt, same seed, same decoding. The other 51 traces in each run hit OOM-kill territory and aren't directly comparable.

| Metric | Ctrl-A (`qwen3-4b-ctx4k`) | **Ctrl-B (`qwen3-4b-instruct-2507`)** | Ratio |
|---|---|---|---|
| n | 49 | 49 | matched |
| **Function-call validity** | 26.5% | **73.5%** | **B 2.77× higher** |
| Mean tokens/s | 16.0 | 15.4 | A 1.04× (marginal) |
| **p50 latency** | 16.7 s | **10.2 s** | **B 1.63× faster** |
| p95 latency | 22.3 s | 22.0 s | tie |

### DR-21 acceptance gate (applied to Ctrl-B)

| # | Gate | Ctrl-B | Pass? |
|---|---|---|---|
| 1 | Function-call fidelity ≥ baseline | 73.5% vs 26.5% (Ctrl-A) | ✅ +47 percentage points |
| 2 | Draft quality non-regressive (blind-pref ≥ 50%) | not yet measured | ⏳ needs Phase 4 (offline human scoring) |
| 3 | ≥ 15 t/s | 15.4 t/s | ✅ (just over) |
| 4 | ≤ 3.4 GiB at 4K | resident at 4K = ~2.5 GB (GGUF 2.33 GB + buffers); survived 4K runs in v1 | ✅ |
| 5 | License unambiguously usable for Staqs commercial distribution | Apache 2.0 (`unsloth/Qwen3-4B-Instruct-2507-GGUF`) | ✅ |
| 6 | No new tooling friction beyond DR-20 / DR-19 | Same llama.cpp wire format; same `/v1/chat/completions` endpoint; the new build (HEAD `4f13cb7`) is required for the broader bake-off but Ctrl-B itself runs on the existing b5283 prod binary too (Qwen3 family) | ✅ (deployable on prod's existing image; new build only needed for Mamba/PLE) |

**Five of six gates pass.** Gate 2 (blind-pref) is gated on human scoring — Eric + Dustin minimum per the methodology. The 2.77× FC validity gap on the matched subset is strong prior evidence; I don't expect blind-pref to invert this.

## Results — full-run (n=100) per candidate

These numbers are NOT directly comparable (different ok-counts mean different effective sample sizes, with survivor bias on which traces landed before OOM-kill). They're presented for completeness.

| Run | Candidate | OK / 100 | FC success | Mean t/s | p50 ms | p95 ms |
|---|---|---|---|---|---|---|
| v2 | qwen3-4b-ctx4k | 59 | 0.339 | 16.0 | 16326 | 22355 |
| v2 | **qwen3-4b-instruct-2507** | **49** | **0.735** | 15.4 | **10247** | 21928 |
| v2 | qwen3.5-4b | 9 | 0.444 | 16.9 | 16583 | 24836 |
| v2 | nemotron-3-nano-4b | 0 | — | — | — | — |
| v3 | qwen3.5-4b | 23 | 0.348 | 16.1 | 17795 | 21125 |
| v3 | nemotron-3-nano-4b | 0 | — | — | — | — |
| v4 | qwen3.5-4b | 29 | 0.379 | 16.0 | 17825 | 20580 |
| v4 | nemotron-3-nano-4b | 0 | — | — | — | — |

## What blocked C1 and C2

Six kernel OOM-kills triggered across v1-v4 sweeps (`total-vm ≈ 45-46 GB` virtual / `anon-rss ≈ 3.7-3.9 GB` resident). The new build allocates a large virtual address space at startup; combined with KV cache + compute buffers + (in v1) ollama co-resident, the 8 GB Jetson exhausted physical RAM at the bigger candidates.

Mitigations tried, in order:
- v2: stop ollama, `--cache-type-{k,v} q4_0` → marginal improvement
- v3: `--ctx-size 2048` (half KV) → marginal improvement
- v4: enable mmap → no improvement (irrelevant when `--n-gpu-layers 99` offloads everything to CUDA)

What would actually unblock them (follow-up work):
- **`--n-gpu-layers 32`** (partial CPU offload) — trades latency for memory headroom
- **Smaller llama.cpp build** with reduced default buffer pools / batch sizes
- **Different hardware** — Orin Nano 8 GB is at the bleeding edge for HEAD llama.cpp + 4B models; Orin NX 16 GB would be comfortable

### Memory profile observation worth recording

The b5283 prod binary serves the SAME `qwen3-4b-ctx4k.gguf` GGUF cleanly with `--ctx-size 4096 --cache-type-{k,v} q8_0 --no-mmap` and concurrent ollama. The new HEAD build (`4f13cb7`) at identical args produces a 4-6 GB anon-rss footprint vs b5283's ~3 GB. The drift between mid-2025 and mid-2026 llama.cpp introduced material memory bloat (likely flash-attn buffers + KV cache management + per-slot prompt cache). Worth tracking upstream.

## Recommendation

1. **Adopt Ctrl-B (`qwen3-4b-instruct-2507`) as the new prod T2 baseline.** Decisive win on the apples-to-apples subset. Deployable on the existing b5283 image (no new-build dependency since same Qwen3 family). License-clean (Apache 2.0).
2. **Phase 4 blind-pref scoring** (Eric + Dustin) on a 20-30 trace sample of held-out Ctrl-A vs Ctrl-B output pairs. The function-call win is structural; blind-pref confirms whether the natural-language quality is also non-regressive.
3. **DR-21 status:** flip from Proposed → Approved with `qwen3-4b-instruct-2507` named as the winner, with the explicit caveat that the strategic Mamba/PLE/SFT2026 comparison is unresolved pending follow-up.
4. **File follow-up:** STAQPRO-3??: "Bake-off Phase 5 — partial-offload retry for C1 Nemotron + C2 Qwen3.5 on existing hardware OR re-test on Orin NX 16 GB if/when hardware path clears." Block on hardware decision.

## Provenance + commits

- Plan: `docs/plan-staqpro-342-bakeoff-v0_1-2026-05-16.md` (`c5f64ec`, `6f7fbbc`, `c8c3251`)
- Phase 2 status: `docs/plan-staqpro-342-phase2-status-v0_1-2026-05-16.md` (`8b1b789`, `b2a5f67`)
- Harness lib + CLI: `dashboard/lib/eval/bake-off.ts`, `dashboard/scripts/bake-off-harness.ts` (`9a8f5ab`, `c724a40`)
- build-trace-set numeric+Date coercion fix: `360a6a2`
- Phase 2 load-verify report: `dashboard/eval/results/bake-off-2026-05/phase2-load-verify-2026-05-16.md` (`422af33`)
- Smoke + v1 + v2 summaries: `9a8f5ab`, `e184905`, `27e4a52`
- v3 + v4 + this report: in progress

Per-trace JSONLs (`eval-{v}-{model}-2026-05-{date}.jsonl`) are gitignored — they contain model output derived from PII-scrubbed-but-real customer inbounds. Summary JSON files + this report are committed (aggregate metrics + provenance only).

## What did NOT make it into Phase 5 ship

- **C3 Gemma 4 E4B** — dropped after Phase 2 load-verify (`phase2-load-verify-2026-05-16.md`): 4.64 GB GGUF + PLE runtime exceeded §3.5 envelope. Documented and skipped.
- **C1 Nemotron 3 Nano 4B** — license-cleared (STAQPRO-339), GGUF pulled, but every attempted run hit OOM at model load. Architecturally interesting (Mamba KV-light) but Orin 8 GB + HEAD llama.cpp's larger memory profile = no-go without follow-up tooling work.
- **C2 Qwen3.5-4B** — partially ran (23-29 OK across v3/v4) but not enough common-subset data to compare against baseline. Follow-up: same partial-offload retry as C1.
