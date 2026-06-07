# Plan — STAQPRO-342: Three-Way T2 Model Bake-Off (DR-21)

> **Status:** PROPOSAL — not yet approved, not yet executed
> **Issue:** STAQPRO-342 (M5, Priority: High, parent STAQPRO-336)
> **Author:** Claude (2026-05-16 session)
> **For:** Dustin (review + execute on a non-prod Jetson)
> **Target spec:** `addendum-t2-model-candidates-v0_2-YYYY-MM-DD.md` (this plan precedes the addendum update)

---

## TL;DR

All five Linear "Blocked by" prereqs (STAQPRO-338, 339, 340, 341, 343) are Delivered. STAQPRO-342
is **Ready for Development** as of 2026-05-16. This plan decomposes the bake-off into 5 phases
covering ~1-2 weeks of mixed code + operator + scoring time.

**Three things shape this plan:**

1. **GEPA never produced lift.** Run-1 = +0.000, Run-2 (relaxed judge + 429 retry) = +0.000.
   The "fairly-tuned baseline" sequencing requirement in the 342 description (level 3) collapses
   to level 2: prompt-quick-wins (STAQPRO-341, code-merged 2026-05-14) + few-shot/audit
   follow-ups (STAQPRO-357, in flight, PR #107). Run-3-against-v1.1-corpus is a parallel
   experiment, not a 342 blocker — cross-architecture differences (Nemotron Mamba, Qwen3.5 SFT,
   Gemma 4 PLE) are not noise GEPA prompt deltas would swallow.

2. **The v1.1 trace corpus does not yet exist on master.** STAQPRO-365 patched the
   `build-trace-set.ts` filter logic but the v1.1 JSONL needs to be regenerated from M1's live
   `mailbox.sent_history`. Trace JSONLs are gitignored (real customer email even when
   PII-scrubbed); they live on operator workstations only. **Important correction (v0.1.2,
   2026-05-16):** v1.1 is NOT a 8K/16K long-context subset — it's the v1.0 trace set
   re-extracted with two corpus-quality filters (drop forwarded/quoted-reply rows; dedupe to
   one canonical reply per inbound). The long-context tier is **STAQPRO-340.1**, which is
   explicitly **out of scope** for STAQPRO-342. The bake-off uses ONE trace set version (v1.1
   with ~70-80 traces post-filtering from M1's ~444-row `sent_history`), not two.

3. **The bake-off model-comparison harness does not exist.** `rag-eval-harness.ts` is
   RAG-dimensioned; `trace-set.ts` is the abstraction layer; what's missing is a
   `bake-off-harness.ts` that loops `{candidate_models × trace_sets}`, hits each via
   llama.cpp HTTP (the DR-25 `LlamaCppClient` in `dashboard/lib/llm/`), captures per-trace
   JSON, and emits the §5.8 metrics surface.

---

## What STAQPRO-342 actually asks for

| # | Deliverable | Where it lives | Code or operator? |
|---|---|---|---|
| D1 | Eval runs for all candidates on §5.8 trace v1.0 + v1.1 | `dashboard/eval/results/bake-off-2026-05/` (gitignored JSONL + committed summary) | Operator (sweep against test-bench Jetson) |
| D2 | Comparison report: function-call success, mean t/s, p95 latency, peak memory, blind-pref win rate | Same dir, committed `report.md` | Code (aggregate) + human (blind-pref) |
| D3 | DR-21 status flipped Proposed → Approved, winner named | `addendum-t2-model-candidates-v0_2-...md` | Code (doc bump) |
| D4 | T2 baseline model swap deployed to `mailbox-jetson-01` (M1) | Operator on M1 | Operator |
| D5 | Addendum v0.2 documenting the bake-off | `docs/addendum-t2-model-candidates-v0_2-YYYY-MM-DD.md` | Code (doc) |

---

## Candidate set (post-339 license clarity)

| # | Model | Tag / source | Memory @ Q4_K_M | License | Status |
|---|---|---|---|---|---|
| C1 | NVIDIA Nemotron 3 Nano 4B | HF: `nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF` | ~2.7 GiB (Mamba KV-light) | Nemotron Open Model | **STAQPRO-339 v0.2 cleared** — attribution requirements landed in `NOTICE` |
| C2 | Qwen3.5-4B | HF: `Qwen/Qwen3.5-4B-Instruct-GGUF` (or community Q4_K_M) | ~3.1-3.3 GiB | Apache 2.0 | Confirm Q4_K_M tag at pull time |
| C3 | Gemma 4 E4B | HF: `google/gemma-4-e4b-it-GGUF` (or community) | ~3.0 GiB (PLE) | Apache 2.0 | **Tooling-gated** — verify llama.cpp parser support |
| Ctrl-A | `qwen3:4b-ctx4k` (current baseline, post-341/357) | Already on M1 | ~2.7 GiB | Apache 2.0 | The comparison floor |
| Ctrl-B | `qwen3-4b-instruct-2507` (free-upgrade) | HF: `Qwen/Qwen3-4B-Instruct-2507-GGUF` | ~2.7 GiB | Apache 2.0 | Same-family minor bump |

If C3 tooling is unstable at sweep time per the issue's caveat, drop to a 4-way (C1, C2, Ctrl-A,
Ctrl-B) and note in the report.

---

## Phase decomposition

### Phase 0 — Trace corpus regen (operator session)

**Goal:** Generate `dashboard/eval/t2-traces/v1.1/` JSONL on the operator workstation by running
the patched (post-STAQPRO-365) `build-trace-set.ts` against M1's `mailbox.sent_history`. JSONLs
stay local; v1.1 README + manifest.example.json + .gitignore already committed on master.

**Steps (from the v1.1 README regen procedure):**
1. `ssh -L 5432:localhost:5432 mailbox1 -N &` (background SSH tunnel)
2. `APPLIANCE_PASSWORD=$(op item get 'mailbox1' --vault MailBOX --reveal --fields password)`
3. From `dashboard/`:
   `POSTGRES_URL="postgresql://mailbox:${APPLIANCE_PASSWORD}@localhost:5432/mailbox" \
    npx tsx scripts/build-trace-set.ts \
      --out eval/t2-traces/v1.1 \
      --set-version v1.1 \
      --appliance mailbox1`
4. Pin `--extracted-at <iso>` if byte-identical re-runs are needed.
5. Verify output: expect ~70-80 `.trace.json` files + `manifest.json` (per v1.1 README).
6. The JSONL is gitignored; only commit if `manifest.example.json` or README needs an update.

**Time estimate:** ~30 minutes operator time (SSH tunnel, script run, verification).
**Risk:** M1's `sent_history` is currently 444 rows total; after forwarded-chain filter +
dedupe, expect ~70-80 traces. Sufficient for bake-off but on the lower end — note in report.

**Auth scope note:** This step reads M1 Postgres credentials and customer email bodies
(PII-scrubbed but still real). Auto-mode classifier flagged the autonomous run as
out-of-scope of "go with M1" — this step needs explicit operator authorization or runs as
a manual operator session.

### Phase 1 — Bake-off harness (code, this worktree)

**Goal:** Write `dashboard/scripts/bake-off-harness.ts` + supporting library code to run
`{candidates × trace_sets}` through llama.cpp HTTP and capture per-trace metrics.

**Components:**
- `dashboard/lib/eval/bake-off.ts` — pure-TS loop over `Trace[]`, calls `LlamaCppClient.chat()`,
  captures `{ output, latency_ms, tokens_in, tokens_out, t/s, peak_rss_kb, function_call_valid }`.
- `dashboard/scripts/bake-off-harness.ts` — CLI wrapper: `--model <tag> --trace-set <v1.0|v1.1>
  --runtime-url http://localhost:8080 --run-tag eval-{model}-{date} --out <dir>`.
- Per-run JSONL output: one line per trace with the full capture surface.
- Manifest-style provenance: model tag/digest, quantization, ctx length, seed, runtime version
  (llama.cpp git SHA), trace-set manifest SHA, run timestamp.

**Why TS not Python:** `trace-set.ts` is already TS; `LlamaCppClient` is already TS; the
existing `rag-eval-harness.ts` pattern is TS. Matching the codebase per User CLAUDE.md §3.5.

**Time estimate:** ~4-6 hours of code + tests.

### Phase 2 — Model retrieval (operator on test bench)

**Goal:** Pull GGUFs to the test-bench Jetson; verify each loads in llama.cpp under §3.5 envelope.

**Test-bench: M1 (DECIDED 2026-05-16).** Heron Labs production box `mailbox-jetson-01`
(`mailbox1`, `192.168.50.179`). Trade-off accepted: M1 has the larger `sent_history` corpus
which Phase 0's trace generation benefits from, and running the sweep on M1 means the §3.5
envelope validation in Phase 5 happens on the same hardware the winner deploys to (no
hardware-delta surprise). Cost: during the sweep window, M1's prod llama.cpp is stopped so the
candidate model can take the GPU. Drafts will stall on the < 30s SLO during that window.

**SLO carve-out (Phase 3 scheduling):**
- Sweep runs overnight (target 02:00-05:00 PT) when inbound volume is near zero per M1's
  historical Gmail Get cadence.
- Classify keeps Ollama unchanged (per CLAUDE.md "classify still uses Ollama directly"
  post-DR-25), so the 5-min poll cycle continues and inbox_messages stays current.
- Drafts queue up during the window; backlog drains within ~10 min of the sweep ending and
  prod llama.cpp resuming.
- Operator pre-notice to Heron Labs operator the day before the sweep window.

Steps per candidate:
1. `hf download <repo> <file>` to `mailbox1:/home/bob/models/`
2. Boot llama.cpp server with each model on a non-prod port (or stop the prod container during
   the sweep window). Confirm successful load and `nvidia-smi` shows < 7.5 GiB.
3. Smoke prompt: "Summarize: hello world" → response within 10s.

**Time estimate:** 30 min/model × 5 = ~2.5 operator hours, mostly download.

### Phase 3 — Eval sweep (mostly machine time)

**Goal:** Run Phase 1's harness × Phase 2's models × Phase 0's trace set. 5 models × 1 trace
set (v1.1, ~70-80 traces) = 5 runs. Each run = ~75 traces × ~5s each = ~6 min/run. Total ~30
min of machine time per pass.

Steps:
1. SSH to mailbox1 (pre-notice Heron Labs operator the day before).
2. At the carve-out window start, `docker compose stop` the prod llama.cpp container.
3. For each candidate: start llama.cpp with that model on its dedicated port, run harness
   for both trace sets (the harness can run from the operator workstation hitting M1's port
   via the LAN), shut down server, swap model, repeat.
4. At window end, restart prod llama.cpp. Confirm classify lag stat green; drain draft backlog.
5. Aggregate JSONLs into `dashboard/eval/results/bake-off-2026-05/{model}-{trace-set}.jsonl`
   (gitignored; copy summary to committed `report.md`).

**Time estimate:** 2-3 hours operator time (mostly waiting); scheduled overnight 02:00-05:00 PT
per the SLO carve-out in Phase 2.

### Phase 4 — Blind-pref scoring (human)

**Goal:** For draft-quality dimension, §5.8 requires Eric + Dustin minimum to blind-rate
held-out output pairs. Function-call/latency/memory dimensions are mechanical; win-rate is the
only one that needs humans.

**Steps:**
1. Code: `dashboard/scripts/build-blind-pref-pairs.ts` that takes two model JSONLs, samples
   30-50 traces, emits a CSV/JSON of `{trace_id, output_A, output_B}` with A/B randomized.
2. Eric + Dustin score independently (likely a shared sheet or a quick Next.js side-page).
3. Aggregate to per-candidate win-rate vs baseline.

**Time estimate:** 1 hour of code; 1-2 hours per scorer × 2 scorers = ~3-4 human-hours total.

### Phase 5 — Decision + ship

**Goal:** Pick a winner per DR-21 acceptance gate, document, deploy.

**Steps:**
1. Apply DR-21 gate (1: function-call ≥ baseline; 2: blind-pref win ≥ 50%; 3: ≥ 15 t/s;
   4: ≤ 3.4 GiB at 4K; 5: license clear (339); 6: no new tooling friction).
2. If multiple pass, tiebreaker: `blind-pref` > `license clarity` > `long-context headroom`.
3. Write `report.md` with full result table + chosen winner + rationale.
4. Bump `docs/addendum-t2-model-candidates-v0_2-2026-XX-XX.md`; flip DR-21 status Proposed → Approved.
5. Operator: deploy winner to M1 (swap model tag in `.env`, `docker compose up -d` the llama.cpp
   service — existing DR-25 cutover runbook applies).
6. Verify M1 §3.5 envelope holds after the swap (`nvidia-smi`, classify lag stat green).

**Time estimate:** 2-3 hours code + doc + ~1 hour operator on M1.

---

## Open questions / decisions to gather as we go

1. ~~Test bench: M2 vs M1?~~ **Decided 2026-05-16: M1.** SLO carve-out documented in Phase 2.
2. **Run-3 GEPA against v1.1 corpus.** Should this run in parallel during the bake-off? Doesn't
   block 342, but if v1.1 unlocks GEPA gradient signal, addendum v0.2 should mention.
3. **Gemma 4 E4B tooling.** If llama.cpp's Gemma 4 parser isn't stable by Phase 2, drop C3.
4. ~~**Trace set size for v1.1.**~~ **Resolved 2026-05-16:** v1.1 is the post-365 quality-filter
   set (not long-context). Expected ~70-80 traces from M1's 444-row `sent_history`. Lower-end
   but adequate — noted in the report rather than blocking on a larger corpus.

---

## Sequencing

```
Phase 1 (code, ~6h) [DONE c724a40] ──────────────────────────┐
                                                             ├──▶ Phase 3 (sweep, ~1h) ──▶ Phase 4 (scoring, ~4h) ──▶ Phase 5 (ship, ~3h)
Phase 0 (corpus, ~30min) [BLOCKED on auth scope] ─┐          │
                                                  ├──▶ Phase 2 (models, ~2.5h)─┘
(Phase 0 + 2 + 3 all SSH to M1 — sweep overnight per the SLO carve-out)
```

Total wall-clock: ~1-2 working days assuming the human-scoring step fits a single afternoon and
Phase 0 unblocks promptly.

---

## Acceptance criteria (mirror of 342's DR-21 gate)

The bake-off is **complete** when:

1. Eval runs captured for all candidates on both trace sets (Phase 3 output)
2. `eval/results/bake-off-2026-05/report.md` committed with the comparison table + winner
3. `addendum-t2-model-candidates-v0_2-YYYY-MM-DD.md` committed with DR-21 flipped to Approved
4. T2 baseline swapped on `mailbox-jetson-01` with classify + draft healthy for ≥ 6 hours

---

## Why this plan is conservative

- Treats v1.1 corpus generation as an explicit phase, not a bullet — it's the actual gate.
- Treats the bake-off harness as new code, not an extension of `rag-eval-harness.ts` —
  the dimensions are different (model swap vs RAG on/off).
- Treats the test bench (M2 vs M1) as a load-bearing decision, surfaced not assumed.
- Treats blind-pref scoring as a real phase with code + scheduling, not a hand-wave.

The Linear issue body is correct about the *intent*; this plan grounds the intent in concrete
steps with hardware reality checks at each phase boundary.
