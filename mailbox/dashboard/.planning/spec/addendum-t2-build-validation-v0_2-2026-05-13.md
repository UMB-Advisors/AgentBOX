# thUMBox Platform — Addendum: T2 Build Validation, v0.2 (DR-25 llama.cpp Migration)

> **Target spec version:** v2.2 → v2.3
> **Addendum started:** 2026-05-13
> **Supersedes:** none (additive to v0.1; v0.1 remains the canonical source for §3.5.1–§3.5.4, DR-16 through DR-20, SM-60–SM-65)
> **Status:** PROPOSAL — DR-25 design locked; §3.5.5 envelope numbers pending on-device execution
> **Author:** Dustin (UMB Group)
> **For:** Eric + Kevin SDK-abstraction review, then Board record
> **Companion docs:** [`addendum-t2-model-candidates-v0_1-2026-05-13.md`](../../docs/addendum-t2-model-candidates-v0_1-2026-05-13.md), [`gsd-mailbox-draft-quality-v0_1-2026-05-13.md`](../../docs/gsd-mailbox-draft-quality-v0_1-2026-05-13.md), [`plan-staqpro-338-llamacpp-migration-v0_1-2026-05-13.md`](../../docs/plan-staqpro-338-llamacpp-migration-v0_1-2026-05-13.md), [`runbook/llamacpp-migration.v0.1.0.md`](../../docs/runbook/llamacpp-migration.v0.1.0.md)

---

## Why this addendum exists

The 2026-05-13 draft-quality design conversation promoted llama.cpp on T2 from a Phase 2 nice-to-have (originally captured as a deferred item) to a **Phase 1 hard prerequisite** because both top bake-off candidates (Nemotron 3 Nano 4B, Gemma 4 E4B) require it. STAQPRO-338 carries the implementation work; this addendum documents the resulting decision (DR-25), the SDK HTTP abstraction landing the wire change cleanly, the re-validation framework that gates production cutover, and the additions to the operational quirks register.

The v0.1 addendum (2026-04-25) closed at DR-20. The root `CLAUDE.md` "Active decision records" table opened DR-21 through DR-24 outside the addendum lineage (KV-cache, cloud-pivot, dashboard-stack pivot, ORM choice). **DR-25 resumes the addendum-numbered sequence.**

---

## Change Log (v0.2 additions)

| Date | Section | Summary |
|------|---------|---------|
| 2026-05-13 | §3.5.5 (NEW) | DR-25 re-validation envelope — five metrics gating production cutover |
| 2026-05-13 | §5.6.l (NEW amendment) | Local inference runtime now selectable (`LOCAL_INFERENCE_RUNTIME=ollama \| llama-cpp`); Ollama retained on T3+, optional on T2 |
| 2026-05-13 | §7.4.k (NEW amendment) | n8n drafting + classify workflows now route through the dashboard's `/api/internal/llm/*` proxy so wire-protocol concerns are owned by one process |
| 2026-05-13 | §8.6.q (NEW) | Operational quirks register entries specific to llama.cpp `server` supervision (`/health`, `/slots`, `/metrics`; no `ollama ps` equivalent) |
| 2026-05-13 | §11 (AMEND) | Risk register additions: llama.cpp ARM64+CUDA build risk, envelope translation drift risk, new SPOF via dashboard proxy |
| 2026-05-13 | DR-25 (NEW) | Decision: llama.cpp as T2 local inference runtime (Phase 1); SDK HTTP abstraction; Ollama retained on T3+ |
| 2026-05-13 | §10 (AMEND) | New SMs SM-66 through SM-70 (DR-25 re-validation acceptance metrics) |

---

## §3.5.5 DR-25 Re-Validation Envelope (NEW)

> **Source:** STAQPRO-338 plan, 2026-05-13; numbers populated post on-device execution
> **Spec section affected:** New subsection of §3.5
> **Change type:** NEW
> **Status:** TARGETS LOCKED, MEASUREMENTS PENDING

DR-25 swaps the T2 inference runtime from Ollama to llama.cpp for the local route. The §3.5.1 envelope must hold without regression. Each metric below is re-measured under llama.cpp and must meet the target before the cutover is declared green.

| # | Metric | DR-18 baseline (Ollama, §3.5.2) | DR-25 target (llama.cpp) | Measurement method | Measured value (TBD) |
|---|--------|---------------------------------|--------------------------|--------------------|----------------------|
| SM-66 | Generation rate (Qwen3-4B Q4_K_M, full GPU offload, jetson_clocks pinned) | 18.66 t/s | **≥ 18.66 t/s** (–0% regression budget; this is the bake-off control) | `llama-bench -m qwen3-4b-ctx4k.gguf -n 128 -p 512 -ngl 99`, or `eval_duration / eval_count` from a 10-call rolling window | _TBD_ |
| SM-67 | Cycle latency, p95, 5-email batch | 5–9 s | **≤ 9 s p95** | `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FROM execution_entity WHERE "workflowId" = (SELECT id FROM workflow_entity WHERE name='MailBOX-Classify') AND "finishedAt" > now() - interval '24h'` | _TBD_ |
| SM-68 | Combined model + KV cache footprint | ~3.4 GiB | **≤ 4.0 GiB** (1.9 GiB transient headroom preserved) | `nvidia-smi --query-gpu=memory.used --format=csv` minus baseline before llama-cpp container start; cross-check `cat /proc/$(pgrep llama-server)/status \| grep VmRSS` | _TBD_ |
| SM-69 | OOM-killer events per 24h | 0 | **0** | `docker logs mailbox-llama-cpp-1 \| grep -i "killed\|oom"` + `dmesg \| grep -i "out of memory"` | _TBD_ |
| SM-70 | Single-cycle success rate over 24h soak | ≥ 99% (~288 cycles at 5-min cadence) | **≥ 99%** | `mailbox.classification_log` inserts ÷ `MailBOX-Classify` `execution_entity` rows over the same window | _TBD_ |

**Acceptance:** all five metrics meet target with no regression beyond instrument noise (±10% on latency, ±200 MiB on memory). A failure on any metric blocks the cutover and rolls back to `LOCAL_INFERENCE_RUNTIME=ollama` via the env flip (runbook §4 rollback).

---

## §5.6.l Local Inference Runtime Selector (AMEND)

> **Source:** STAQPRO-338, 2026-05-13
> **Spec section affected:** Existing §5.6 (Local model defaults)
> **Change type:** AMEND

T2 supports two local inference runtimes, selected per appliance via env:

```
# T2 local inference runtime — one of: ollama | llama-cpp
LOCAL_INFERENCE_RUNTIME=ollama

# llama.cpp server (only used when LOCAL_INFERENCE_RUNTIME=llama-cpp)
LLAMA_CPP_BASE_URL=http://llama-cpp:8080
LLAMA_CPP_MODEL=qwen3-4b-ctx4k
```

T3 (Mac mini M4) stays on Ollama unconditionally — DR-25's scope is T2-only. Embedding model `nomic-embed-text:v1.5` stays on Ollama on both tiers (RAG ingestion path unchanged); migrating embeddings to llama.cpp is captured as a follow-up ticket but is not gated by STAQPRO-338.

The selector resolves at the dashboard's `dashboard/lib/drafting/router.ts` and at the `/api/internal/llm/*` proxy routes. n8n workflow JSON is **runtime-agnostic** — it sees `baseUrl` per-call and an Ollama-shape response envelope regardless of the underlying runtime.

---

## §7.4.k n8n → Dashboard Proxy for Local Inference (AMEND)

> **Source:** STAQPRO-338, 2026-05-13
> **Spec section affected:** Existing §7.4 (n8n usage patterns)
> **Change type:** AMEND

Prior to DR-25, n8n's classify path was hardcoded to `http://ollama:11434/api/generate`. Under DR-25, it routes via the dashboard at `http://mailbox-dashboard:3001/api/internal/llm/api/generate`. The draft path's `={{ baseUrl }}/api/chat` template is preserved — the dashboard's `pickEndpoint` now returns `baseUrl=http://mailbox-dashboard:3001/api/internal/llm` when `LOCAL_INFERENCE_RUNTIME=llama-cpp` (the proxy intercepts `/api/chat` and forwards), and the existing `http://ollama:11434` baseUrl when `=ollama` (zero-overhead, no proxy in path).

The proxy serves Ollama's `/api/generate` and `/api/chat` request/response shapes 1:1, regardless of the underlying runtime. Envelope translation (Ollama ↔ llama.cpp's OpenAI-compatible `/v1/chat/completions`) happens inside the proxy in `dashboard/lib/llm/llamacpp-client.ts`. This keeps n8n workflow JSON unchanged across runtime changes; the only n8n edit DR-25 requires is the classify-path URL swap (one node).

**Why a dashboard proxy and not just swapping the URL in workflow JSON directly to a hypothetical llama-server with Ollama-compat:**

- llama.cpp's `server` does expose `/api/chat` and `/api/generate` in roughly Ollama-compatible shape, but field-level drift is documented in upstream issues (`eval_count`, `prompt_eval_count`, `eval_duration` semantics differ; some fields absent). The draft-finalize route extracts `input_tokens` and `output_tokens` from those fields, so silent drift would corrupt cost tracking and `state_transitions` metadata.
- The dashboard already owns the boundary contract with n8n (STAQPRO-186). Adding envelope translation here keeps the contract in one process.
- The alternative — runtime selection via env in n8n directly (two HTTP nodes + IF gate) — duplicates the call-site per workflow and bakes the runtime decision into JSON that ships per appliance. Exactly what the "swappable per appliance" requirement (§5.3 amendment) tells us to avoid.

**Cost added:** ~5–10 ms per inference call (extra HTTP hop + envelope normalization). Negligible against typical ~3–9 s classify latency. **New SPOF:** dashboard restart now interrupts inference cycles; mitigated by Next.js graceful-restart (<2 s bounce) and the 5-min Schedule cycle's at-least-once dedup-keyed insert pattern (a missed cycle recovers next cycle).

---

## §8.6.q llama.cpp Operational Quirks (NEW)

> **Source:** STAQPRO-338 design + upstream `llama.cpp/server` documentation, 2026-05-13
> **Spec section affected:** Existing §8.6 (Operational Quirks Register)
> **Change type:** NEW

### §8.6.q.1 — No `ollama ps` equivalent

llama.cpp's `server` does not expose a per-model session listing. Operational equivalents:

| Operator need | Ollama | llama.cpp |
|---|---|---|
| Is the server up? | `docker exec mailbox-ollama-1 ollama ps` | `curl http://llama-cpp:8080/health` |
| What's loaded? | `ollama list` | `ls /models` on the container; server only loads what `-m` points at |
| Per-slot occupancy | n/a | `curl http://llama-cpp:8080/slots` (with `--slots` flag) |
| Token rate / timings | response envelope `eval_count` / `eval_duration` | response envelope `timings.predicted_per_second` (or `/v1` route's `usage` block) |

Document these in the operator runbook (`docs/runbook/llamacpp-migration.v0.1.0.md` §6 Observability).

### §8.6.q.2 — Single-model server, no hot-swap

Ollama can serve multiple model tags from one daemon and unload/reload on demand. llama.cpp's `server` binary loads exactly one model per process. For multi-model workloads (currently not in scope on T2 — only `qwen3:4b-ctx4k` is served locally), run multiple `server` containers on different ports. This is a structural difference: Ollama is daemon-centric, llama.cpp is process-per-model.

### §8.6.q.3 — `KEEP_ALIVE` is implicit (no auto-unload)

Ollama defaults to a 5-minute unload after idle. We override with `OLLAMA_KEEP_ALIVE=24h` (v0.1 §3.5.2). llama.cpp's `server` keeps the model loaded for the lifetime of the process — no equivalent setting needed. Container restart is the unload mechanism.

### §8.6.q.4 — GGUF file required directly, no Modelfile abstraction

Ollama's `qwen3:4b-ctx4k` is a Modelfile-built named tag layered over a base GGUF blob. llama.cpp consumes GGUFs directly. The `--ctx-size 4096` flag enforces DR-18's context cap at process start; no Modelfile equivalent.

Source: either re-download from HuggingFace (`huggingface-cli download Qwen/Qwen3-4B-GGUF qwen3-4b-q4_k_m.gguf`) or extract from Ollama's blob store (`~/.ollama/models/blobs/sha256-*`, resolved via `ollama show qwen3:4b --modelfile`). The runbook recommends HuggingFace as the primary path — decouples from Ollama's storage layout.

### §8.6.q.5 — `--no-mmap` is the appliance-correct flag

llama.cpp defaults to mmap-loading weights. On unified-memory Jetson, mmap can cause unpredictable page faults under multi-container pressure. `--no-mmap` allocates the weights into anonymous memory at process start, behavior closer to Ollama's loader — predictable footprint at the cost of slower cold-start.

---

## §11 Risk Register Additions (AMEND)

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| llama.cpp ARM64 + CUDA build fails on Jetson | Medium | High — blocks the entire migration | Pre-validate against ghcr.io/ggml-org/llama.cpp's `server-cuda` ARM64 manifest before attempting source build; runbook documents both paths. Source build is ~30–60 min on-device with linker memory pressure on 8 GB — if it OOMs during link, fall back to image pull. |
| Envelope drift between Ollama and llama.cpp responses | Low after dashboard proxy lands | High — silent classification corruption | Proxy normalizes envelope; **pre-cutover diff** of 20 sample classify responses on identical input (runbook §3.2) gates the env flip. Tests in `dashboard/lib/llm/__tests__/llamacpp-envelope.test.ts` cover the round-trip mathematically. |
| New SPOF: dashboard outage interrupts inference | Low | Medium | Dashboard graceful-restart <2 s; 5-min Schedule cycle's dedup-keyed inserts recover next cycle. Acceptable trade vs the contract win. |
| Performance regression below 18.66 t/s baseline | Low | Medium — contaminates the bake-off control | `llama-bench` runs before cutover; rollback path is the env flip. |
| Memory regression vs Ollama | Medium | High — could trip OOM-killer on a customer box | §3.5.5 SM-68 gates cutover; both runtimes can run side-by-side during validation (combined ~5.5 GiB + ~3.4 GiB exceeds T2's 7.4 GiB usable, so the side-by-side window is brief — measure llama-cpp alone after stopping ollama, then run soak). |
| Loss of `ollama logs` / `ollama ps` operational convenience | Certain | Low | §8.6.q.1 quirks register documents equivalents. |
| Cutover dark window exceeds 60 s SLO | Low | Medium | Dashboard recreate <2 s; pre-warm llama-cpp model load before flipping `LOCAL_INFERENCE_RUNTIME`. |
| M2 customer drift (M2 stays on Ollama initially) | Medium | Medium | DR-25 lands on M1 first; M2 backport is a follow-up ticket once M1 has 7-day green soak. M2's tighter compose (no host port bindings) requires a mirrored llama-cpp service definition (no `ports:` block). |

---

## Decision Record DR-25 (NEW)

### DR-25: llama.cpp as T2 Local Inference Runtime (Phase 1)

**Type:** Tactical | **Date:** 2026-05-13 | **Status:** Proposed — pending Eric + Kevin sign-off on SDK HTTP abstraction direction, then implementation via STAQPRO-338

**Decision:** Replace Ollama with llama.cpp on T2 as the local inference runtime for `qwen3:4b-ctx4k` (and future T2 model candidates per STAQPRO-342 bake-off). Ollama retained on T3+. An SDK HTTP abstraction in the dashboard (`dashboard/lib/llm/` + `/api/internal/llm/*`) decouples n8n workflows from the runtime choice; switching is one env var (`LOCAL_INFERENCE_RUNTIME=ollama | llama-cpp`) plus a container recreate.

**Context:** The 2026-05-13 model bake-off (STAQPRO-342, DR-21) is the Phase 1 capstone for the M5 draft-quality workstream. It evaluates three candidates against the current `qwen3:4b-ctx4k` baseline:

- **Nemotron 3 Nano 4B** — NVIDIA hybrid Mamba-Transformer architecture
- **Qwen3.5-4B** — successor to current baseline, conventional Transformer
- **Gemma 4 E4B** — Google's Per-Layer Embeddings architecture

Two of the three candidates require llama.cpp for first-class support:

- Mamba layer support is in llama.cpp; lags in Ollama (open upstream issues track Mamba state primitives that Ollama's runner doesn't yet pass through cleanly).
- Per-Layer Embeddings work in llama.cpp via direct GGUF support; Ollama's library packaging for Gemma 4 E4B is downstream of llama.cpp and lags by weeks.

Without llama.cpp on T2, STAQPRO-342 collapses to a single-candidate evaluation (Qwen3.5-4B only), which defeats the purpose of a bake-off. STAQPRO-338 is therefore on the critical path: five M5 issues block on it (STAQPRO-342, 345, 346, 347, 350).

**Alternatives considered:**

| Option | Trade-off |
|--------|-----------|
| Stay on Ollama, drop Nemotron and Gemma from the bake-off | Defeats the purpose of a three-way evaluation; a single-candidate "swap" provides no signal on architectural diversity. |
| Wait for Ollama upstream to ship Mamba + PLE support | Open-ended timeline; blocks the entire M5 draft-quality workstream until Ollama catches up. |
| Use llama.cpp as a transient binary (CLI invocation) rather than `server` | Breaks the long-running poll pattern; per-call model reload cost (~3 s) dominates inference cost (~5 s). |
| Adopt llama.cpp as primary on both T2 and T3 | Out of scope for STAQPRO-338. T3 has memory headroom and Ollama's operational ergonomics (`ollama ps`, multi-model serve, library) are worth the cost where memory pressure permits. |
| Runtime selection via env in n8n directly (two HTTP nodes + IF gate per workflow) | Duplicates call-sites; bakes runtime decision into workflow JSON that ships per appliance — exactly the "swappable per appliance" requirement we want to avoid. |
| Make llama.cpp serve Ollama-compatible endpoints natively (no dashboard proxy) | llama.cpp `server`'s `/api/chat` and `/api/generate` are *close* to Ollama-compatible but drift on `eval_count` / `prompt_eval_count` / `eval_duration` shape. Draft-finalize parses those fields for cost tracking; silent drift = corrupted token accounting. Proxy is the correct boundary. |

**Rationale:**

1. **Bake-off enabler.** Direct dependency of STAQPRO-342; without DR-25, the bake-off cannot run.
2. **SDK abstraction limits blast radius.** n8n stays runtime-agnostic. A future runtime swap (mlx? tensor-rt-llm? something else?) is the same surgical edit: one client adapter + one env var.
3. **Reversible.** `LOCAL_INFERENCE_RUNTIME=ollama` env flip restores Ollama; both containers can coexist during validation if memory allows.
4. **Unlocks downstream M5 work.** STAQPRO-347 (host-memory KV cache) and STAQPRO-350 (constrained decoding) both depend on llama.cpp's API surface, not Ollama's.

**Cost:**

- Operational complexity. Ollama's container-with-systemd convenience is lost; llama.cpp `server` supervision documented in §8.6.q.
- ~5–10 ms latency per inference call from the dashboard proxy hop (negligible vs ~3–9 s classify).
- New SPOF: dashboard outage now interrupts inference. Mitigated by Next.js graceful-restart and the 5-min cycle's at-least-once dedup recovery.
- One-time on-device build cost: 30–60 min compile or ~5 min image pull, plus model GGUF download (~2.5 GiB).

**Caveats:**

- **Embedding model stays on Ollama.** `nomic-embed-text:v1.5` is unchanged. If Ollama is fully retired from T2 later, a successor ticket migrates embeddings.
- **DR-18 (4K context) re-validated under llama.cpp.** `--ctx-size 4096` flag enforces the cap at process start; envelope holds (§3.5.5).
- **M1 first, M2 follows.** Customer #2 (M2, `mailbox.staqs.io`) stays on Ollama until M1 has 7-day green soak under DR-25. Backport plan filed as STAQPRO-338's closing follow-up.
- **Hot rollback policy: keep Ollama running for 7 days post-cutover.** Memory cost is ~3.4 GiB; T2 has the headroom only if llama-cpp runs lean. Confirmed acceptable for the 7-day window.

**Affects:**

- §3.5.5 (NEW — re-validation envelope and acceptance metrics)
- §5.6.l (AMEND — runtime selector added)
- §7.4.k (AMEND — n8n endpoint via dashboard proxy)
- §8.6.q (NEW — operational quirks register entries for llama.cpp specifics)
- §11 (AMEND — risk register additions)
- §10 (AMEND — SM-66 through SM-70 added)
- Root `CLAUDE.md` Active decision records table — DR-25 row added
- `dashboard/CLAUDE.md` Routes section — `/api/internal/llm/*` routes added on implementation

---

## SM-66 through SM-70 (NEW — see §3.5.5 table)

These are the five re-validation metrics that gate DR-25's production status flip from "Proposed" → "Implemented." Listed inline in §3.5.5 to keep the acceptance bar visible alongside the targets.

---

## Provenance + cross-references

- Linear issue: https://linear.app/staqs/issue/STAQPRO-338
- Implementation plan: [`docs/plan-staqpro-338-llamacpp-migration-v0_1-2026-05-13.md`](../../docs/plan-staqpro-338-llamacpp-migration-v0_1-2026-05-13.md) (Stages 1–5)
- Operator runbook: [`docs/runbook/llamacpp-migration.v0.1.0.md`](../../docs/runbook/llamacpp-migration.v0.1.0.md) (on-device session script)
- Model candidates analysis: [`docs/addendum-t2-model-candidates-v0_1-2026-05-13.md`](../../docs/addendum-t2-model-candidates-v0_1-2026-05-13.md)
- M5 roadmap context: [`docs/gsd-mailbox-draft-quality-v0_1-2026-05-13.md`](../../docs/gsd-mailbox-draft-quality-v0_1-2026-05-13.md)
- v0.1 addendum (foundational, do not duplicate): [`addendum-t2-build-validation-v0_1-2026-04-25.md`](./addendum-t2-build-validation-v0_1-2026-04-25.md)
- Downstream-blocked Linear: STAQPRO-342 (bake-off), STAQPRO-345 (close-out), STAQPRO-346 (style vectors), STAQPRO-347 (KV cache), STAQPRO-350 (constrained decoding)
