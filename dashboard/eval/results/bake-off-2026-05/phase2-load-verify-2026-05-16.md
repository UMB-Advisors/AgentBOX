# Phase 2 Load-Verify Results — STAQPRO-342

> **Run:** 2026-05-16 20:14-20:25 PDT, ~11 min prod downtime
> **Image:** `local/llama-cpp:cuda-jetson` = `dustynv/llama_cpp:b5283-r36.4-cu128-24.04` (DR-25 cutover image, pushed 2025-05-06)
> **Method:** Stopped prod llama-cpp; for each candidate, ran a one-shot `docker run` with the same args as prod compose (`--ctx-size 4096 --flash-attn --cache-type-k q8_0 --cache-type-v q8_0 --n-gpu-layers 99 --no-mmap`); waited for `/health`; smoke prompt; killed. Restored prod at end.

## Results

| # | Candidate | File | Load | Smoke latency | Smoke output | Notes |
|---|---|---|---|---|---|---|
| Ctrl-A | qwen3:4b-ctx4k | `qwen3-4b-ctx4k.gguf` | ✅ | 1034 ms | `<think>\nOkay, the user wants...` | Thinking-mode active without `/no_think` in prompt (prod compensates via system-prompt) |
| Ctrl-B | Qwen3-4B-Instruct-2507 | `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | ✅ | 204 ms | `READY` (2 tokens) | Clean non-thinking output by default; no `/no_think` needed |
| C2 | Qwen3.5-4B | `Qwen3.5-4B-Q4_K_M.gguf` | ❌ | — | — | `llama_model_load: error loading model arch` — arch string `qwen35` not in this binary |
| C1 | Nemotron-3-Nano-4B | `NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf` | ❌ | — | — | `error loading model architecture: 'nemotron_h'` — hybrid Mamba arch not in this binary |
| C3 | Gemma 4 E4B | `gemma-4-E4B-it-Q4_K_M.gguf` | ❌ | — | — | Load failure (likely Gemma 3n/4 arch unsupported) |

## Diagnosis

**The current M1 llama.cpp binary (`b5283`, pushed May 2025) supports 2 of 5 candidates.**

All three failures are the same class: GGUF architecture identifiers that the binary's loader registry doesn't recognize:
- `qwen35` (Qwen3.5 release, Feb 2026)
- `nemotron_h` (Nemotron-Hybrid Mamba, Mar 2026)
- `gemma3n` / `gemma4` (Gemma 4 E4B PLE, May 2026)

All three architectures landed in upstream llama.cpp at various points across 2026. The `b5283` tag corresponds to a llama.cpp commit from May 2025 — predates all three architectures.

## Secondary findings

1. **`nvidia-smi --query-gpu=memory.used,memory.total` returns `[N/A], [N/A]` on the Jetson Orin Nano.** Unified memory architecture — the GPU doesn't have a separate memory pool nvidia-smi can query. The bake-off "peak memory" metric needs a Jetson-specific implementation (likely `tegrastats` parsed, or `cat /proc/meminfo` delta).

2. **Ctrl-A returns thinking-mode output without explicit `/no_think`.** The bake-off prompt assembler (`assembleMinimalDrafterPrompt`) doesn't include `/no_think`, so Ctrl-A will spend tokens on chain-of-thought when scored vs. Ctrl-B which is naturally non-thinking. For the bake-off, either add `/no_think` to the system prompt OR accept that Ctrl-A's tokens/s and function-call validity will reflect production behavior (which DOES use `/no_think`).

3. **`dustynv/llama_cpp` registry appears stale.** Latest tag is `b5283-r36.4-cu128-24.04` pushed 2025-05-06; no newer Jetson-specific tags visible on Docker Hub. Upgrade path is either source build (per DR-25 runbook) or a different registry.

## Decision matrix

To unblock C1/C2/C3 for the bake-off:

| Path | Effort | Risk | Pros | Cons |
|---|---|---|---|---|
| **Source build on M1** | 1-2 hr operator time | Medium — DR-25 runbook covers it | Most current, exactly the llama.cpp HEAD | Build time on ARM64, prod swap risk |
| **Alternative image** | 0.5 hr research | Low | Quick if a maintained Jetson image exists | Unknown if one exists; community-maintained registries may also lag |
| **2-way bake-off** | 0 hr | None | Settles the "free upgrade" question (Ctrl-A vs Ctrl-B) | Loses strategic Mamba/PLE/SFT2026 comparison |
| **Defer the whole bake-off** | 0 hr | None | No risk | STAQPRO-342 stays open longer |

## What ran cleanly

The verify procedure itself worked end-to-end:
- Stop prod, swap-in candidate via one-shot `docker run`, capture metrics, restore prod
- Prod returned healthy after restoration (`docker compose ps llama-cpp` shows Up, `/v1/models` returns the model card)
- ~11 min total downtime

The same procedure will work for the actual bake-off sweep (Phase 3) — just the inference-loop scope swaps to `bake-off-harness.ts` and the per-candidate sweep is 359 traces × ~5s instead of one smoke prompt.

## Recommendation

Surface to operator: **2-way (Ctrl-A vs Ctrl-B)** is meaningfully informative on its own — it answers "does the 2507 minor bump beat the prod baseline" with zero architectural risk and could be a Phase 3 deliverable today. The fuller 5-way bake-off blocks on a llama.cpp upgrade workstream that's not in 342's original scope.

Alternatively, file a follow-up issue for the upgrade and keep 342 in flight.
