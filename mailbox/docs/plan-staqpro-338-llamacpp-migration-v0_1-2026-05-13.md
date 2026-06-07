# Plan — STAQPRO-338: llama.cpp Migration on T2 (Phase 1 prerequisite)

> **Status:** PROPOSAL — not yet approved, not yet executed
> **Issue:** STAQPRO-338 (M5, Priority: High, parent STAQPRO-336, blocks STAQPRO-342/345/346/347/350)
> **Author:** Claude (autonomous /linfor session, 2026-05-13)
> **For:** Dustin (review + execute on `mailbox-jetson-01` / customer-#1 appliance)
> **Target spec:** addendum-t2-build-validation v0.2 (this plan precedes the addendum update)

---

## TL;DR

STAQPRO-338 asks for a runtime swap on the live T2 appliance: replace the in-container Ollama
serving `qwen3:4b-ctx4k` with a llama.cpp server, then update the n8n drafting workflow to hit
the new endpoint and re-validate the §3.5 memory envelope. The work is a physical-hardware
migration on customer-#1's production box (`mailbox.heronlabsinc.com` / `mailbox-jetson-01` /
`mailbox1`), not a code-only change.

**Three things make this not autonomously shippable today, captured here so we can unblock:**

1. **The DR-20 reference in the issue points at a slot that's occupied.** DR-20 in
   `addendum-t2-build-validation-v0_1-2026-04-25.md` is *"Postgres Insert/Update over Execute
   Query"* — nothing to do with llama.cpp. The llama.cpp decision needs a fresh DR. This plan
   proposes **DR-25**.

2. **The issue's own scope says** *"Eric and Kevin need briefing on the SDK HTTP abstraction
   implications before this commits."* That's a human-in-the-loop gate baked into the ticket.

3. **There is no on-device work product to ship without the appliance.** The deliverables
   (llama.cpp built + running, n8n endpoint swapped, §3.5 envelope re-validated) all require
   SSH'ing into `mailbox1`, ARM64 + CUDA compile time, and operator validation against a live
   customer's email pipeline.

This document is the **plan** that gets us from current state to "DR-25 Implemented" in one
operator session, plus the supporting code + addendum updates that *can* be PR'd ahead of
time once Eric/Kevin approve the SDK abstraction direction.

---

## What STAQPRO-338 actually asks for

Verbatim from the issue, decomposed:

| # | Deliverable | Where it lives | Can autonomous agent do it? |
|---|---|---|---|
| D1 | llama.cpp built + running on `mailbox-jetson-01` with CUDA | On-device | No — physical box |
| D2 | `qwen3:4b-ctx4k` migrated from Ollama to llama.cpp as baseline | On-device | No — physical box |
| D3 | n8n drafting workflow updated to hit the new endpoint | `n8n/workflows/MailBOX-Classify.json`, `MailBOX-Draft.json` | **Partial** — can author the JSON diff, can't validate without the new endpoint live |
| D4 | §3.5 T2 envelope re-validated under llama.cpp | On-device benchmarking | No — physical box |
| D5 | `addendum-t2-build-validation-v0_2-YYYY-MM-DD.md` documenting DR-25 (was "DR-20" in the ticket) as "Implemented" | This repo | **Yes** — can be drafted now, finalized post-execution |
| D6 | SDK HTTP abstraction so n8n doesn't care which runtime serves requests | `dashboard/lib/drafting/` or new module | **Partial** — design is doable now; the issue requires Eric/Kevin sign-off before commit |

---

## Why now (per the issue's "Why" section)

The 2026-05-13 design conversation promoted DR-20-llama.cpp from Phase 2 nice-to-have to
Phase 1 hard prerequisite. The bake-off (STAQPRO-342, three-way Nemotron 3 Nano 4B vs
Qwen3.5-4B vs Gemma 4 E4B per DR-21) cannot run until llama.cpp lands because:

- **Nemotron 3 Nano 4B**: hybrid Mamba-Transformer; Mamba layer support is in llama.cpp,
  lags in Ollama.
- **Gemma 4 E4B**: Per-Layer Embeddings architecture; same Ollama-lag story.
- **Qwen3.5-4B** could run on current Ollama, but evaluating one candidate defeats the
  purpose of a bake-off.

STAQPRO-338 is therefore on the critical path for M5's draft-quality workstream. Five
issues currently block on it (STAQPRO-342, 345, 346, 347, 350).

---

## Current state (as of 2026-05-13)

### Inference runtime on M1 / mailbox1 (live, customer #1)

- **Service:** `ollama` container, image `ollama/ollama@sha256:662109db...` (Ollama 0.20.5)
  pinned per STAQPRO-240.
- **Model:** `qwen3:4b-ctx4k` (Modelfile-built 4096-context Qwen3-4B Q4_K_M per DR-18).
- **Endpoint:** `http://ollama:11434/api/generate` (internal docker DNS) and `http://ollama:11434/api/chat`.
- **Memory envelope:** ~3.4 GiB resident for model + KV cache (per addendum §3.5.1).
- **Other-container call-sites:**
  - `n8n/workflows/MailBOX-Classify.json` line 264 → `http://ollama:11434/api/generate`
  - `n8n/workflows/MailBOX-Draft.json` local route → same shape
  - Dashboard `OLLAMA_BASE_URL` env (currently commented in `.env.example`, defaults
    `http://ollama:11434`); used by RAG embed path (`dashboard/lib/rag/embed.ts`) and
    backfill scripts.

### What's NOT moving in this migration

- **Cloud route stays untouched.** `gpt-oss:120b` via Ollama Cloud and the Anthropic Haiku
  alt remain via existing OpenAI-compatible HTTP shape; the dashboard forwards `baseUrl` +
  `apiKey` per call (`/api/internal/draft-prompt` response).
- **Embedding model stays on Ollama.** `nomic-embed-text:v1.5` is used for RAG ingestion
  (`dashboard/lib/rag/embed.ts`). llama.cpp supports embeddings but Ollama's library
  packaging for `nomic-embed-text:v1.5` is the current path. Migrating embeddings is
  out-of-scope for STAQPRO-338 — captured as a follow-up below.
- **T3 (Mac mini M4) stays on Ollama.** DR-20-llama.cpp scope is T2-only per the original
  decision's trade-off.

---

## Proposed approach

### Stage 1: SDK HTTP abstraction (PR-able now, pending Eric/Kevin sign-off)

Introduce a thin per-call runtime selector in the dashboard so n8n's `MailBOX-Classify` and
`MailBOX-Draft` HTTP Request nodes hit the dashboard's internal proxy, and the dashboard
forwards to either Ollama or llama.cpp based on env config.

**Why a dashboard proxy and not just swapping the URL in workflow JSON:**

- llama.cpp's `server` exposes both an Ollama-compatible `/api/chat` shape (via
  `--api-key` and proper CORS) and a native `/v1/chat/completions` shape (OpenAI-compatible).
  In practice they're close but not byte-identical to Ollama's response envelope — fields
  like `eval_count`, `prompt_eval_count`, `eval_duration` may differ. The classify path's
  `Normalize` node currently parses Ollama's response shape.
- A dashboard proxy gives us **one place** to handle envelope translation, request shaping,
  and runtime selection — keeping n8n workflows runtime-agnostic.
- The boundary contract (`dashboard/CLAUDE.md` "n8n Boundary Contract") already centralises
  these wires; adding `/api/internal/llm/{classify,draft}` keeps the contract tight.

**Files (proposed, not yet written):**

```
dashboard/lib/llm/
  runtime.ts          # selects ollama | llama-cpp from env
  ollama-client.ts    # extracted from current direct HTTP calls
  llama-cpp-client.ts # new, OpenAI-compatible HTTP shape
  envelope.ts         # normalises {response, eval_count, …} across both

dashboard/app/api/internal/llm/
  classify/route.ts   # forwards to runtime, returns Ollama-shape envelope
  draft/route.ts      # forwards to runtime, returns Ollama-shape envelope
```

**Env config (proposed additions to `dashboard/.env.example`):**

```
# T2 local inference runtime — one of: ollama | llama-cpp
LOCAL_INFERENCE_RUNTIME=ollama

# llama.cpp server (only used when LOCAL_INFERENCE_RUNTIME=llama-cpp)
LLAMA_CPP_BASE_URL=http://llama-cpp:8080
LLAMA_CPP_MODEL=qwen3-4b-ctx4k
```

**n8n workflow change (one node URL each):**

- `MailBOX-Classify > Ollama Call`: `http://ollama:11434/api/generate`
  → `http://mailbox-dashboard:3001/api/internal/llm/classify`
- `MailBOX-Draft > Local Ollama`: similar swap
- Request body shape unchanged; response envelope unchanged (dashboard does translation).

**Risk this design has to clear with Eric/Kevin:**

- **Adds dashboard as a single point of failure** between n8n and the inference runtime.
  Today n8n talks to Ollama directly; if the dashboard restarts during a poll cycle, that
  cycle fails. Mitigation: the dashboard already restarts gracefully (Next.js process
  bounces in <2s) and the 5-min Schedule cycle's at-least-once dedup-keyed insert pattern
  recovers next cycle. But it is a new dependency.
- **Adds ~5-10ms latency** per inference call (extra HTTP hop + envelope normalisation).
  Negligible against typical ~3-9s classify latency, but worth noting.
- **Alternative considered:** runtime selection via env in n8n directly (two separate HTTP
  nodes with an IF gate). Rejected because it duplicates the call-site in every workflow
  and bakes the runtime decision into JSON that ships per appliance — exactly what the
  "swappable per appliance" requirement (§5.3 amendment) tells us to avoid.

### Stage 2: llama.cpp build on `mailbox-jetson-01` (operator session, on-device)

**Approach: docker-compose service `llama-cpp` running an ARM64 + CUDA build.**

llama.cpp ships an ARM64 + CUDA Dockerfile (`.devops/cuda.Dockerfile`). Build invocation
(runbook draft — to be validated on-device):

```bash
# On mailbox1, in a fresh dir alongside the mailbox repo
git clone --depth=1 https://github.com/ggerganov/llama.cpp /opt/llama.cpp
cd /opt/llama.cpp
# Use the CUDA Dockerfile; --build-arg CUDA_VERSION to match JetPack 6.2 (CUDA 12.6)
docker build -f .devops/cuda.Dockerfile \
  --build-arg CUDA_VERSION=12.6.0 \
  --build-arg CUDA_DOCKER_ARCH=sm_87 \
  -t local/llama-cpp:cuda-jetson \
  .
```

`sm_87` is the Jetson Orin Nano's compute capability (Ampere). Build time estimate on the
Jetson: 30-60 minutes (CUDA toolchain link is slow on ARM64 with 8 GB RAM; consider
cross-building on the workstation and pushing to a local registry if the on-device build
runs out of memory).

**Compose service (proposed `docker-compose.yml` snippet):**

```yaml
llama-cpp:
  image: local/llama-cpp:cuda-jetson
  runtime: nvidia
  command: >-
    -m /models/qwen3-4b-ctx4k.gguf
    -c 4096
    --host 0.0.0.0
    --port 8080
    -ngl 99
    --no-mmap
  volumes:
    - ./llama-cpp-models:/models:ro
  ports:
    - "8080:8080"   # LAN-only on M1; remove ports: block on M2 per M2's tighter binding
  restart: unless-stopped
```

**Model file sourcing:**

The current `qwen3:4b-ctx4k` is an Ollama Modelfile-built tag, not a standalone GGUF. The
underlying base `qwen3:4b` weights are GGUF-compatible — Ollama stores them as GGUF
internally. Two paths to get a GGUF for llama.cpp:

1. **Re-pull from upstream**: `huggingface-cli download Qwen/Qwen3-4B-GGUF qwen3-4b-q4_k_m.gguf`.
   Then the 4096-context cap is enforced by llama.cpp's `-c 4096` flag, not a Modelfile.
2. **Extract from Ollama's local blob store**: `~/.ollama/models/blobs/sha256-*` — Ollama
   stores GGUF blobs verbatim; the Modelfile is metadata. Resolve the digest via
   `ollama show qwen3:4b --modelfile` and copy the blob. Faster (no re-download) but
   tightly coupled to Ollama's storage layout.

Path 1 is the recommended primary; Path 2 is the fast path if connectivity is a constraint
during the migration window.

### Stage 3: Cutover (operator session, on-device)

Sequenced cutover on `mailbox1` to minimise the customer-#1 dark window:

1. **Pre-flight (offline, before SSH):** confirm Stage 1 dashboard build is deployed and
   `LOCAL_INFERENCE_RUNTIME=ollama` still points to the existing Ollama (zero behavioural
   change — abstraction is in place but inert).
2. **Build llama.cpp container** (Stage 2).
3. **Pull GGUF model**, place under `./llama-cpp-models/qwen3-4b-ctx4k.gguf`.
4. **Start `llama-cpp` service** alongside Ollama (both running, ~5.5 GiB combined budget — well within T2's 7.4 GiB usable; the existing 1.9 GiB headroom shrinks but does not exhaust). If memory check fails, stop Ollama first; this is the "harder cutover, no rollback window" path.
5. **Validate llama.cpp endpoint** with a manual classify request matching the n8n payload
   shape. Compare against current Ollama response on the same input.
6. **Flip `LOCAL_INFERENCE_RUNTIME=llama-cpp` in dashboard `.env`**, recreate dashboard
   container (`docker compose up -d mailbox-dashboard`).
7. **Watch one or two 5-min cycles** for classify + draft success in n8n logs +
   `mailbox.classification_log`.
8. **Run §3.5 envelope re-validation** (memory, latency, generation rate; see Stage 4).
9. **If green:** stop `ollama` service, free 3.4 GiB. If red: flip env back, restart
   dashboard, file regression notes.

**Estimated dark window:** 30-90s during step 6 dashboard container recreate. Steps 5-8 are
parallel/observational and don't interrupt traffic.

### Stage 4: Re-validate §3.5 envelope under llama.cpp

The addendum's §3.5 envelope was measured against Ollama. Each metric needs re-measurement
to confirm DR-25 doesn't regress what DR-18 (4K context) bought us.

| Metric | DR-18 baseline (Ollama, §3.5.2) | DR-25 target (llama.cpp) | Method |
|---|---|---|---|
| Generation rate (Qwen3-4B Q4_K_M, full GPU offload) | 18.66 t/s | **≥ 18.66 t/s** (control for bake-off) | `llama-bench` or `/timings` field in llama.cpp's response |
| Cycle latency (5 emails, classify batch) | 5-9s | **≤ 9s p95** | n8n `execution_entity` query, same as SM-60 |
| Combined model + KV cache footprint | ~3.4 GiB | **≤ 4.0 GiB** (OOM safety margin) | `nvidia-smi` or `/proc/<llama-cpp-pid>/status` VmRSS |
| OOM-killer events / 24h | 0 | **0** | `docker logs llama-cpp \| grep "signal: killed"` — same as SM-61 |
| Single-cycle success rate over 24h (~288 cycles at 5-min cadence) | ≥ 99% | **≥ 99%** | classify_log inserts / n8n execution count |

**Acceptance:** all five metrics meet target with no regression beyond instrument noise
(±10% on latency, ±200 MiB on memory).

### Stage 5: Addendum v0.2 — finalise DR-25

After Stage 4 passes, update `dashboard/.planning/spec/addendum-t2-build-validation-v0_1-2026-04-25.md`
into a new `addendum-t2-build-validation-v0_2-YYYY-MM-DD.md` adding **DR-25 (NEW)**:

```
DR-25: llama.cpp as T2 local inference runtime (Phase 1)
Type: Tactical | Date: <execution date> | Status: Implemented

Decision: Replace Ollama with llama.cpp on T2 as the local inference runtime for
qwen3:4b-ctx4k (and future T2 model candidates per STAQPRO-342). Ollama retained on T3+.
SDK HTTP abstraction (dashboard /api/internal/llm/*) decouples n8n workflows from the
runtime choice.

Context: The 2026-05-13 model bake-off (STAQPRO-342) requires Nemotron 3 Nano 4B
(hybrid Mamba) and Gemma 4 E4B (PLE) candidate support. Both are llama.cpp-first;
Ollama lags. Without llama.cpp on T2, the bake-off cannot run.

Alternatives considered:
- Stay on Ollama, drop Nemotron/Gemma from the bake-off — defeats the purpose of a
  three-way evaluation; Qwen3.5-4B alone provides no comparison signal.
- Wait for Ollama to ship Mamba/PLE support — open-ended timeline; blocks M5.
- Use llama.cpp transient binary (not server) — breaks the polling pattern; reload
  cost dominates inference cost.
- llama.cpp as primary on both T2 and T3 — out of scope for STAQPRO-338; T3 has more
  memory headroom and Ollama's operational convenience is worth the cost there.

Rationale:
1. Bake-off enabler — direct dependency of STAQPRO-342.
2. SDK abstraction limits blast radius — n8n stays runtime-agnostic.
3. Reversible — LOCAL_INFERENCE_RUNTIME env flip restores Ollama; both containers can
   coexist within T2's envelope during cutover.

Cost: Operational complexity. Ollama's container-with-systemd convenience is lost;
llama.cpp server supervision documented in this addendum's runbook section.

Caveats:
- Embedding model (nomic-embed-text:v1.5) stays on Ollama for now. RAG ingestion path
  unchanged. Migrating embeddings to llama.cpp is a follow-up if Ollama is fully
  retired from T2; not required by STAQPRO-338.
- DR-18 (4K context) re-validated under llama.cpp; envelope holds (§3.5 re-measured).

Affects: §3.5 (re-validated), §5.6 (runtime added), §7.4 (n8n endpoint via dashboard
proxy), §8.6 (new operational quirks register entries for llama.cpp specifics).
```

Also amend §5.6 to add llama.cpp as the runtime, §7.4 to document the dashboard-proxy
pattern, and the change log table.

---

## Risks (per the issue + new ones surfaced)

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Memory regression vs Ollama | Medium | High — could trip OOM-killer on a customer box | Stage 4 §3.5 re-validation gates the cutover; both runtimes can run side-by-side during validation if memory allows |
| Performance regression below 18.66 t/s baseline | Low | Medium — would contaminate the bake-off control | `llama-bench` before cutover; rollback path is the env flip |
| llama.cpp ARM64 + CUDA build fails on Jetson | Medium | High — blocks the entire migration | Pre-validate the build on a workstation cross-compile or in a Jetson VM if available; document fallback to upstream `ghcr.io/ggerganov/llama.cpp:server-cuda` if it ships ARM64 |
| Response envelope drift breaks `Normalize` node | Low | High — silent classification corruption | Dashboard proxy normalises envelope; **before cutover, diff 20 sample classify responses Ollama vs llama.cpp on identical input** and confirm `eval_count`, `done`, `response` fields align |
| Loss of `ollama ps` / `ollama logs` operational convenience | Certain | Low | Document equivalent llama.cpp server endpoints (`/health`, `/metrics`, `/slots`) in the §8.6 quirks register |
| Cutover dark window exceeds 60s SLO | Low | Medium | Dashboard recreate is <2s; step 6 is the only interrupting moment; pre-warm llama.cpp model load before flipping env |
| **DR number collision (DR-20 reference in ticket is stale)** | Certain | Low | This plan proposes DR-25; flag in the Linear comment so Eric/Kevin review the renumbering before merge |
| **Customer #2 (M2, `mailbox.staqs.io`) drift** | Medium | Medium | This migration lands on M1 first. M2's compose differs (no public host port bindings on ollama/n8n/qdrant); the llama-cpp service definition must mirror M2's tighter binding model. STAQPRO-338 acceptance should include the M2 backport plan or an explicit "M1-only for now" note. |

---

## Follow-ups out of scope for STAQPRO-338

- **Embedding runtime migration.** `nomic-embed-text:v1.5` stays on Ollama. If Ollama is
  fully retired from T2 later, file a successor ticket.
- **Constrained decoding (STAQPRO-350).** llama.cpp's grammar/JSON-schema enforcement is
  what unlocks this ticket; it becomes implementable post-DR-25.
- **Host-memory KV cache for persona prefix (STAQPRO-347).** llama.cpp's `--no-mmap` +
  `--prompt-cache` flags are the mechanism. Land DR-25 first, then this follow-up.
- **Style Vector spike (STAQPRO-346).** Activation steering requires hooks into the
  inference forward pass that Ollama doesn't expose; llama.cpp's API surface is more open
  but still requires custom server patches. Spike post-DR-25.

---

## Acceptance criteria (proposed for STAQPRO-338 closure)

1. Dashboard `LOCAL_INFERENCE_RUNTIME` env switches between Ollama and llama.cpp with
   no n8n workflow JSON edit required (SDK abstraction in place).
2. On `mailbox-jetson-01`, `LOCAL_INFERENCE_RUNTIME=llama-cpp` serves `qwen3:4b-ctx4k`
   GGUF via the new `llama-cpp` compose service with `--runtime nvidia` confirming CUDA
   load.
3. §3.5 envelope re-measured under llama.cpp; all five metrics in Stage 4 table meet
   target.
4. 24-hour soak: classify + draft success rate ≥99% with no OOM-killer events.
5. `addendum-t2-build-validation-v0_2-YYYY-MM-DD.md` committed; DR-25 status =
   **Implemented**.
6. Root `CLAUDE.md` "Active decision records" table updated to add DR-25.
7. M1 production confirmed green; M2 backport plan filed as a successor or explicit
   "M2 stays on Ollama for now" note in STAQPRO-338's closing comment.

---

## What can be done autonomously, what needs Dustin

| Item | Who |
|---|---|
| Author this plan | Done (Claude) |
| Comment on STAQPRO-338 flagging DR collision + human gate | Done (Claude) |
| Stage 1 dashboard SDK abstraction PR | Claude can author the code; **Dustin reviews + Eric/Kevin sign off the abstraction direction** before merge |
| Stage 1 n8n workflow JSON diff | Claude can author; **applied only after Stage 1 dashboard merges + Stage 2 build is ready** |
| Stage 2 llama.cpp build on mailbox1 | Dustin (SSH, ~30-60 min compile, on-device) |
| Stage 3 cutover | Dustin (SSH, ~15-30 min including validation) |
| Stage 4 §3.5 re-validation | Dustin + Claude can prep the harness scripts |
| Stage 5 addendum v0.2 commit | Claude can draft from this plan once Stage 4 numbers are in |

---

## Open questions for Eric / Kevin / Dustin

1. **DR numbering.** This plan claims DR-25. Confirm — DR-20 in the issue is a stale
   reference to a number already taken by the Postgres node decision.
2. **SDK abstraction location.** Is `dashboard/lib/llm/` + `/api/internal/llm/*` the right
   home, or do we want a separate "inference proxy" microservice? The simpler "dashboard
   absorbs it" path is what's proposed here; a separate service is the more decoupled
   alternative.
3. **M1-first or both-boxes-same-day.** Customer #2 is one week post-bring-up; safer
   sequencing is M1 first, observe for a week, then M2 backport. Confirm.
4. **Rollback policy.** Stage 3 step 9 says "stop Ollama" on green. Alternative: keep
   Ollama running for 7 days as a hot rollback. Memory cost is ~3.4 GiB; T2 has the
   headroom only if `llama-cpp` runs lean. Confirm preference.
5. **GGUF source.** Stage 2's path 1 (HuggingFace re-download) vs path 2 (extract from
   Ollama's blob store). Path 1 is cleaner; path 2 is faster. Confirm preference.

---

## Provenance

- Issue: https://linear.app/staqs/issue/STAQPRO-338
- Existing addendum: `dashboard/.planning/spec/addendum-t2-build-validation-v0_1-2026-04-25.md`
- DR-18 (4K context, the constraint this migration must not regress): same addendum, §5.6
- §3.5 T2 envelope (memory + latency targets): same addendum, §3.5.1 / §3.5.2
- Live runtime today: `ollama/ollama@sha256:662109db...` on M1 (per root `CLAUDE.md`)
- Blocked downstream: STAQPRO-342, 345, 346, 347, 350
