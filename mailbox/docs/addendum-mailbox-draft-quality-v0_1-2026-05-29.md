# Addendum: Draft-Quality Close-Out (MBOX-119)

> **Target spec:** mailbox-appliance-spec-v3_0-2026-05-19.md
> **Companion specs:** docs/addendum-cloud-use-doctrine-v0_1-2026-05-13.md; docs/addendum-t2-model-candidates-v0_1-2026-05-13.md
> **Companion ADR:** (none yet — LoRA personalization ADR deferred, see §4)
> **Addendum started:** 2026-05-29
> **Status:** DRAFT — pending Eric / Kevin review
> **How to use:** This is the **v0_1 DRAFT** close-out for the MBOX-111 draft-quality epic. Decision Records continue the shared namespace at **DR-59** (current high-water mark = DR-58 per the multi-provider addendum; the MBOX-119 "next would be DR-22" note is stale by 36+ numbers). Success Metrics continue at **SM-96** (high-water = SM-95); open questions at **NC-39** (high-water = NC-38). Content is tiered: **Accepted** decisions reflect delivered, merged work; **Candidate** / **Exploratory** decisions are gated on the spikes named in §6 and **must not be promoted without on-device evidence**. This draft documents what has shipped and **does not** close MBOX-111 — that epic stays open pending MBOX-116 (LoRA) and MBOX-144 (critic loop).

## TL;DR

- This is a **v0_1 DRAFT**, not a final close-out. It records the draft-quality work that has actually shipped as of 2026-05-29 and parks the rest.
- **MBOX-111 stays OPEN.** It cannot be closed until MBOX-116 (per-customer LoRA personalization, BACKLOG/unstarted) and MBOX-144 (generator+critic loop, BACKLOG) are resolved — both are still design-intent only.
- **What is settled (Accepted):** DR-21 T2 bake-off verdict (winner = `qwen3-4b-instruct-2507`, MBOX-112); prompt/context quick wins (MBOX-140); the §5.8 eval harness + trace sets v1.0/v1.1 (MBOX-121/MBOX-135); the llama.cpp T2 migration + DR-25 cutover (MBOX-136); the Nemotron license clearance (MBOX-139); the GEPA "prompt-optimization does not move the needle" finding (MBOX-138/MBOX-114).
- **What is NOT settled:** the LoRA build, the skill/LoRA reconciliation, and the two M4 spikes (style vectors MBOX-118, constrained decoding MBOX-120) — all gated on on-device measurement that has not run.
- **Headline lesson:** the draft-quality lever is the **model**, not the prompt. GEPA returned +0.000 lift across three runs; the win came from the bake-off model swap.

## Change Log

| Date | Section | Summary |
|---|---|---|
| 2026-05-29 | DR-59 → DR-62 (NEW) | Four new Decision Records claimed (next-free above DR-58) |
| 2026-05-29 | SM-96 → SM-99 (NEW) | Four new Success Metrics claimed (next-free above SM-95) |
| 2026-05-29 | NC-39 → NC-41 (NEW) | Three new open questions claimed (next-free above NC-38) |
| 2026-05-29 | §6.2 / footer / refs (SYNC) | MBOX-120 constrained-decoding code split from the bundled #179 and **merged to master via PR #183** (flag OFF); issue stays In Development pending the package bump + on-device eval. Added the n8n-forwarding gate + the GBNF-ambiguity review note surfaced during the PR #183 review. |

---

## §1. Doctrine restatement: minimize-cloud, with sunset criteria (AMEND DR-4 / restates DR-21-doctrine)

The cloud-use doctrine is the frame for everything in this addendum. Source: `docs/addendum-cloud-use-doctrine-v0_1-2026-05-13.md` (DR-21 "Cloud-Use Doctrine: Minimize, Don't Eliminate", MBOX-117 / STAQPRO-337). That addendum is itself still **DRAFT — pending Eric + Kevin brief before approval**; this close-out restates it and does not change its status.

> **Doctrine (verbatim, cloud-doctrine addendum line 46):** Minimize cloud routing without eliminating it. Local-first by default. Cloud routing is a graceful-degradation path for cases where the local model demonstrably underperforms the operator's quality bar. Each appliance has explicit sunset criteria; cloud routing for that appliance terminates when any criterion is met. The cloud codepath remains in the product spec until the last live customer has sunset.

"Minimize cloud calls" is a **soft architectural constraint, not a hard prohibition** (cloud-doctrine line 22). Cloud LLM routing remains the supported degradation path for `escalate` / `unknown` / `confidence < 0.75` classifications per `dashboard/lib/classification/prompt.ts:routeFor`.

**Sunset criteria (per-customer, ANY-of — cloud-doctrine lines 50-56):**

| # | Criterion | Trigger |
|---|---|---|
| 1 | Quality threshold | Local approval rate ≥ 90% over rolling 30-day window for `LOCAL_CATEGORIES` traffic **AND** ≥ 75% for re-routed `CLOUD_CATEGORIES`. Thresholds open for Eric/Kevin tuning. |
| 2 | LoRA active | A customer-specific LoRA adapter (STAQPRO-344 / MBOX-116) is trained, activated, and passes the eval-gated quality bar (criteria TBD in MBOX-116). |
| 3 | Operator opt-out | `mailbox.system_state.cloud_route_enabled = false` (future migration); dashboard-toggleable; bypasses #1 and #2. |
| 4 | Provider loss | Cloud provider becomes unavailable (legal STAQPRO-339, billing, deprecation) → auto-flip gated-off, notify operator, surface banner. |

When any criterion fires, `routeFor` returns `local` regardless of category and the dashboard surfaces why. **Sunset is capability-gated, not time-based** — a "cloud removed at end of Phase 2" framing was explicitly rejected because it couples doctrine to schedule, not capability. Per-pack scope: applies uniformly across MailBOX / receptionBOX / future packs; per-pack escape hatch only when a pack ships with no local model capable of the task (must be documented in that pack's own §5.x Cloud LLM section).

Note the structural dependency: sunset criterion #2 is exactly the LoRA capability that this addendum parks as **NOT BUILT** (§4). The doctrine has the off-ramp wired; the off-ramp's trigger is unbuilt.

---

## §2. Final pipeline architecture, post-quick-wins / post-bake-off (AMEND)

This is the drafting path as it actually runs on M1 today, after the MBOX-140 quick wins and the MBOX-112 bake-off / MBOX-136 runtime migration. **Post-LoRA (MBOX-116) personalization is NOT yet realized** — the boxes below describe the generic-base + persona-overlay + RAG state, not a per-customer fine-tune.

### Drafting prompt assembly (live, post-MBOX-140)

Source: `docs/addendum-drafting-prompt-audit-v0_1-2026-05-16.md`; PR #81; code in `dashboard/lib/drafting/{strip-quoting,thread-history,prompt,persona}.ts`.

| Stage | Mechanism | Source |
|---|---|---|
| Quote / signature stripping | `stripQuotedAndSignature` removes `On … wrote:`, `-- ` sig blocks, `>` quote lines; body capped `MAX_BODY_CHARS=6000` | `dashboard/lib/drafting/strip-quoting.ts` |
| Thread-history injection | `getThreadHistory` walks `thread_id` across `inbox_messages ∪ sent_history`, strips per-message, caps `THREAD_HISTORY_CHAR_BUDGET=6000` (~1500 tok), renders `## Prior thread context` (further capped `MAX_THREAD_CHARS=2000`). LOCAL always; CLOUD gated by `RAG_CLOUD_ROUTE_ENABLED` | `dashboard/lib/drafting/thread-history.ts` |
| Persona overlay | Live and operator-tuned on M1 ("You are an email assistant for Heron Labs team…"); CRITICAL bracketed-placeholder block with 3 BAD/GOOD pairs to stop fact fabrication | `dashboard/lib/drafting/persona.ts`; audit doc §2 |
| Few-shot exemplars | `getCategoryExemplars` / `## Past replies you've sent…` block exists but is **effectively empty in production** — reads only `mailbox.sent_history`, which on M1 had 444 rows skewed `unknown=441`, so most categories don't fire. Seed gap punted to STAQPRO-357 sub-task 2 | audit doc §2/§5 |

### Inference routing + runtime (live, post-MBOX-112 / MBOX-136 / DR-25)

- **Classify:** `qwen3:4b-ctx4k` via Ollama directly (classify was never migrated to llama.cpp).
- **Draft (local):** `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` served by **llama.cpp** under DR-25 cutover (ACCEPTED 2026-05-15, T+21h clean soak). "Cutover-took" signal = `mailbox.drafts.model='qwen3-4b-ctx4k'` (no colon = llama.cpp path). Source: `project_dr25_cutover_landed.md`; MBOX-112 PR #111; MBOX-136 PR #84.
- **Draft (cloud):** Ollama Cloud `gpt-oss:120b` for `escalate` / `unknown` / `confidence < 0.75` (per cloud doctrine §1).
- **RAG:** `POST /api/internal/draft-prompt` queries Qdrant `email_messages` with hard sender filter; LOCAL always, CLOUD gated by `RAG_CLOUD_ROUTE_ENABLED`.

Pipeline flow is unchanged from the CLAUDE.md canonical diagram (Schedule → Gmail Get → Classify → Draft → queue → approve → MailBOX-Send). The quick wins and the model swap changed *what* the Draft node feeds the model and *which runtime* serves it; they did not change the topology.

**Not realized:** a LoRA hot-swap step at draft time (MBOX-116 design intent, §4). The base model is still generic; per-customer voice today comes only from the persona overlay + (sparse) exemplars + RAG.

---

## §3. DR-21 final: winning T2 base model + rationale + eval results (Accepted)

**Verdict: Accepted.** Source: MBOX-112 (Delivered 2026-05-18; STAQPRO-342) Linear comments + bake-off result table; PRs #111 (prod swap), #112 (harness/feasibility probe); `docs/plan-staqpro-342-bakeoff-v0_1-2026-05-16.md`; `project_dr21_v5_verdict.md`.

**Winner: Ctrl-B `qwen3-4b-instruct-2507`** — a same-family minor-version bump of the baseline, adopted as the new prod T2 drafter and swapped live on M1 (PR #111). All three new-architecture candidates were eliminated by the M1 8 GB hardware envelope under sustained realistic-length inference (kernel OOM, not load failure):

| Candidate | Arch | Outcome on M1 8 GB | Source |
|---|---|---|---|
| Ctrl-B `qwen3-4b-instruct-2507` | Qwen3 (same family) | **WINNER** — survives sustained inference; adopted to prod | MBOX-112; PR #111 |
| C1 Nemotron 3 Nano 4B | Mamba/hybrid | Eliminated — OOM'd mid-sweep; ~45 GB total-vm on HEAD llama.cpp regardless of flags | MBOX-112 |
| C2 Qwen3.5-4B | PLE/new | Eliminated — OOM'd mid-sweep (6 OOM-kills across v1-v4 probes shared w/ C1) | MBOX-112 |
| C3 Gemma 4 E4B | SFT/new | Loaded + drafted high-quality output, then kernel-OOM at trace 11 (max_tokens=512, 13.85 t/s before kill); prime candidate when M5 16 GB+ lands | MBOX-112; `project_dr21_v5_verdict.md` |

**Eval results, Ctrl-B vs Ctrl-A baseline:**

| Metric | Ctrl-A (baseline) | Ctrl-B (winner) | Delta |
|---|---|---|---|
| Function-call validity | 26.5% | 73.5% | 2.77× (+47 pts) |
| Mean throughput | 16.0 t/s | 15.4 t/s | −0.6 t/s |
| p50 latency | 16.7 s | 10.2 s | −6.5 s |

**DR-21 acceptance gate: 5 of 6 passed** — FC fidelity +47 pts (pass); ≥15 t/s (pass at 15.4); ≤3.4 GiB (pass at ~2.5 GB); Apache-2.0 license (pass); no tooling friction (pass). **Gate 2 (blind-pref ≥50%) left pending human Phase-4 scoring** — see §7 SM-96. The recommendation was to flip DR-21 Proposed→Approved naming `qwen3-4b-instruct-2507`, caveated that the Mamba/PLE/SFT new-arch comparison is **unresolved pending 16 GB+ hardware**.

**Rationale:** the bake-off proves the lever is the model, not the prompt (cross-referenced with §3-adjacent GEPA finding below). The same-family winner gave a 2.77× function-call fidelity jump and halved p50 latency at parity throughput, within the 8 GB envelope where every new-architecture candidate OOM'd under realistic generation lengths.

**Supporting finding — GEPA prompt optimization (MBOX-138 / MBOX-114, Delivered):** GEPA produced **+0.000 lift across all three runs** (Run-1 strict judge v1.0; Run-2 relaxed judge v1.0; Run-3 relaxed judge v1.1). The MBOX-114 fixes (relaxed judge metric in `optimization/dspy/metric.py`; 429 exponential backoff) worked as designed — 429-exhaustion fell 73.8%→51.0% — but lift stayed +0.000. Conclusion: prompt optimization does not move the Qwen3-4B draft-quality needle; routed the win-rate problem to the bake-off. Source: `optimization/dspy/README.md`; PRs #83/#86/#99/#101/#110.

**Supporting finding — Nemotron license (MBOX-139, Delivered):** CLEARED for commercial redistribution (verdict GO) under the NVIDIA Nemotron Open Model License (Dec 15 2025) — irrevocable, no unilateral-update clause, no guardrail-bypass auto-termination. DR-21 row-17 license gate locked PASS. Moot for current prod since Nemotron lost the bake-off on hardware, but the clearance stands for any future 16 GB+ revisit. Source: `docs/memo-nemotron-license-review-v0_2-2026-05-14.md`; PR #85.

---

## §4. LoRA personalization design — **Candidate (NOT BUILT)**

**Status: Candidate / NOT BUILT.** Source: MBOX-116 (BACKLOG, `startedAt:null`, `completedAt:null`, no PR, no branch — nothing is built). This section documents **design intent only.** Parent/origin ticket: STAQPRO-344.

**Design intent:** each approved draft becomes a training pair `(inbound + assembled context) → approved reply`; after ~50 approved drafts, train a rank-8/16 LoRA adapter (~30-50 MB) on the customer's corpus. Adapter hot-swapped in at draft time — base model stays generic, the LoRA *is* the customer's voice. Training runs **on-Jetson during idle hours** (data never leaves the box, even to Staqs infra — "the doctrine line"); adapter encrypted under LUKS; retrain weekly→monthly.

**Required guardrails (design intent):**

| # | Guardrail | Intent |
|---|---|---|
| 1 | Eval-before-activation | Auto-run §5.8 trace set against `base + new LoRA` vs `base alone`; activate only if blind-pref win rate improves AND function-calling fidelity preserved |
| 2 | Sparse-corpus overfitting kill criterion | Refuse activation when corpus too thin to generalize |
| 3 | Versioned adapters | One-command rollback |
| 4 | Training-data audit log | Provenance of every training pair |

**Planned deliverable:** pipeline in `training/lora/`, Postgres adapter-version schema, n8n hot-swap, first prod LoRA on Eric's drafts, plus `addendum-mailbox-lora-personalization-v0_1-*.md`.

**Explicit "do not block on this" gate.** MBOX-116 is the **most expensive of three competing personalization paths and explicitly sequenced last, "possibly never."** It must **not** block Phase 2 / the draft-quality milestone. Decision rule (from MBOX-116): if the two cheaper paths together — MBOX-115 (retrieval-augmented few-shot) and MBOX-118 (style-vector spike) — deliver **blind-pref win rate ≥ 50% over base on the §5.8 trace set**, defer LoRA to Phase 3 / M6+ as a quality-tier-2 capability and reallocate the 4-8 weeks. Hard blockers (relations.blockedBy): MBOX-115, MBOX-118, MBOX-112 (must train on the *winning* base — now settled as `qwen3-4b-instruct-2507`, §3 — else every adapter retrains on a base swap), MBOX-121 (eval harness, required for the activation guardrail). Milestone: M6.

---

## §5. Skill / LoRA reconciliation — **OPEN**

**Status: OPEN, pending the LoRA build.** This is deliberately not a fabricated answer — the reconciliation between an edit-to-skill personalization layer and a per-customer LoRA cannot be settled until at least one of them has on-device evidence, and the LoRA (§4) is unbuilt.

**Decision criteria (to be applied once evidence exists), not a verdict:**

| Criterion | Resolves toward skill / few-shot | Resolves toward LoRA |
|---|---|---|
| Blind-pref win rate over base (§7 SM-96/SM-97) | Cheaper path already clears ≥50% bar (MBOX-115 / MBOX-118) → defer LoRA | Cheaper paths plateau below bar; only fine-tune closes the gap |
| Corpus size | Thin corpus (M1 had 444 `sent_history`, 441 `unknown`) favors retrieval/skills | ≥50 approved per-category pairs available → LoRA viable |
| Maintenance cost | Static/dynamic exemplars + skills are days-scale to change | LoRA is 4-8 weeks + retrain cadence + rollback machinery |
| Privacy / doctrine | Both stay on-box | LoRA is the strongest "the doctrine line" — training never leaves the box |
| Stacking | — | Style vectors / few-shot and LoRA may *stack* rather than compete (per `memo-style-vectors-vs-lora` framing) |

The current directional input (NOT a decision): the style-vectors-vs-LoRA memo (`docs/memo-style-vectors-vs-lora-v0_1-2026-05-28.md`, on the PR #179 branch, not this worktree — summarized from the MBOX-118 [LANDED] comment) recommends **ship style vectors as the Phase 2 wedge, defer STAQPRO-344 LoRA to Phase 3+ if style vectors clear the bar.** That recommendation is itself gated on the unbuilt on-device style-vector evidence (§6), so the reconciliation stays OPEN. Tracked as NC-39 (§ Open Questions).

---

## §6. Deferred items, formally parked

Each item carries a tier tag and an explicit gate. MBOX-119 supplied the four deferred names and the status vocabulary (`Candidate / Exploratory / Out of scope`) but did **not** pre-assign tags; assignments below are made here per the addendum convention.

### 6.1 Four formally-parked techniques (MBOX-119 §6)

| Item | Tier | Gate / "do not block Phase X" |
|---|---|---|
| P³ (personalized prompt/pipeline approach) | **Candidate** | Subsumed by the §4/§5 personalization decision; do not block Phase 2 — revisit only if MBOX-115/118 fail to clear the 50% bar |
| n-gram logit steering | **Exploratory** | Do not block Phase 2 or 3. Needs an on-device feasibility check on the llama.cpp path before any plan; no owner, no spike scheduled |
| Local-local speculative decoding | **Exploratory** | Do not block any phase. Latency-only play, competes with MBOX-145 (KV cache) for the latency budget; revisit only if TTFT remains the bottleneck after MBOX-145 |
| Two-pass refinement | **Out of scope** for this milestone | Superseded in spirit by the generator+critic loop (MBOX-144, §6.3); do not block Phase 2 — fold any revisit into MBOX-144 rather than re-opening separately |

### 6.2 M4 spikes — **Exploratory**, with on-device gates

Both spikes are **NOT Delivered** — the operator deliberately left them open pending on-device gates; neither may be promoted without an M1 measurement. **Code state now differs between the two (2026-05-29):** MBOX-120 (constrained decoding) was split clean out of the bundled spike branch and **merged to `master` via PR #183** (flag default OFF — zero runtime change); MBOX-118 (style vectors) **remains off-device** on branch `feat/mbox-118-120-m4-spikes` / PR #179. "Merged code" is not "Delivered": both issues stay In Development until their on-device evidence lands.

**Style-vector spike — MBOX-118 (In Development; Exploratory).** Represent per-customer writing style as a single vector in hidden-activation space; add to a chosen layer at decode time. No fine-tuning, few-KB per customer. Tests StyleVector (naive) and SteerX variants. Shipped scaffold: `optimization/style-vectors/` (uv+pyproject), `extract_naive` + `extract_steerx`, residual-stream steering with genuine λ=0 identity, §5.8-trace eval scaffold (**blind-pref-ready JSONL, no fabricated win-rates**), CLI, pytest. **Open gates (all need Jetson + real corpus):**
- Kill-criterion: hidden-state injection on T2 without losing >30% t/s; **<15 t/s (SM-60 floor) = dead.** M1 number **unmeasured**.
- Blind-pref win rate on Eric's approved drafts (base vs base+vector) — needs corpus + judge; **not run**.
- Productization: prototype uses HF transformers forward hooks; **llama.cpp exposes no hidden-state hook** → production needs a fork / C++ plugin (central feasibility flag).

**Constrained-decoding spike — MBOX-120 (In Development; Exploratory).** GBNF grammar per category enforcing **structure only** (greeting/body/slots/sign-off); body content decodes freely. Scoped to `reorder` first, then `scheduling`. **Merged to `master` via PR #183 (2026-05-29, split clean from the bundled #179):** `reorder.gbnf` + `scheduling.gbnf`, `grammar-dispatch.ts` gated behind `CONSTRAINED_DECODING_ENABLED` (**default OFF**), `grammar?` param plumbed `ollama.ts → llm proxy → llama.cpp`, `grammar-eval.ts` A/B wrapper, `analyze-reorder-structure.ts`, benefit/caveat memo (`docs/memo-constrained-decoding-benefit-map-v0_1-2026-05-28.md`, now on master). Typecheck clean, 6/6 dispatch unit tests pass (re-verified pre-merge). **Open gates (code merged ≠ Delivered — issue stays In Development):**
- The installed `@umb-advisors/llm ^0.1.0` translator does **not** map `grammar` → llama.cpp's native `/completion grammar` field → currently a **NO-OP end-to-end**; needs a package bump in `thumbox-platform` (where the package publishes — outside this repo).
- The production path also needs n8n's `MailBOX-Draft` node to forward the top-level `grammar` from `/api/internal/draft-prompt` into the chat call's `options.grammar` (live-n8n edit; the `grammar-eval.ts` harness hits the llm proxy directly and bypasses n8n, so the eval is unaffected).
- On-device `reorder`/`scheduling` A/B on M1's `qwen3:4b-ctx4k` (blind-pref: does the grammar help or hurt) is **pending** and only meaningful after the package bump; until it runs `CONSTRAINED_DECODING_ENABLED` stays default OFF.
- Live M1 corpus too thin to author data-driven grammars (reorder=2, scheduling=1) → grammars are first-principles structural, not corpus-derived.
- **Review note (PR #183):** the GBNF `body` rule is ambiguous against the structured-slot label lines (a `PO: …` line is also a valid body line), so llama.cpp unions both parse paths and the required-slot constraint only truly bites at EOS — flagged for the on-device eval to watch.

### 6.3 Other parked items adjacent to draft quality

| Item | Issue | Tier | Gate |
|---|---|---|---|
| Generator + Critic loop | MBOX-144 (BACKLOG) | **Candidate** | Blocked by MBOX-112 (bake-off determines same-model vs different-model critic — bake-off now settled, §3) + MBOX-121 (eval). Critic doubles inference cost; must stay under SM-60 10s p95. Design intent only — nothing built. **MBOX-111 close depends on this.** |
| Host-memory KV cache for persona prefix | MBOX-145 (In Development) | **Candidate** | Latency-only, zero quality impact. `cache_prompt=true` + `--prompt-cache` on b5283; ~70-80% TTFT cut on cached prefix. Blocked by MBOX-136 (Delivered). Before/after TTFT on M1 is the open deliverable |
| llama.cpp b5283 → host-memory prompt-caching upgrade (#20574) | MBOX-334 (BACKLOG, Low) | **Exploratory** | Full many-prefix host-RAM KV offload (beyond MBOX-145's single-prefix slice). Same Jetson-rebuild class as MBOX-136. Deliberately Low until MBOX-145's single-prefix win is measured |
| Retrieval-augmented few-shot (dynamic exemplar selection) | MBOX-115 (Delivered — plan only) | **Candidate** | "Delivered" = an implementation plan (PR #164), **no runtime code shipped**. Recommended path: reuse `email_messages` Qdrant collection + swap static recency miner in `dashboard/lib/drafting/exemplars.ts` for similarity+MMR. Caveats: the "update n8n workflow" deliverable is a no-op (prompt assembly centralized in dashboard); 3-5 exemplar / ~2K-token target doesn't fit local Qwen3 4K context. Code not landed |

---

## §7. New Success Metrics (targets to track)

Next-free SM numbers assigned from the registry high-water mark SM-95 (multi-provider addendum). These are **targets to track**, not measured results; baselines noted where known.

| # | Metric | Target | Baseline / status |
|---|---|---|---|
| SM-96 | Blind-pref win rate, draft vs reference, on §5.8 trace set | ≥ 50% over base (DR-21 gate 2; LoRA-defer trigger §4) | **Unmeasured** — DR-21 gate 2 left pending human Phase-4 scoring (§3) |
| SM-97 | Blind-pref win rate, personalization layer vs base (style vector / few-shot / LoRA) | ≥ 50% over base | **Unmeasured** — needs MBOX-118 on-device run + judge (§6.2) |
| SM-98 | Operator edit rate on `pending` drafts (fraction of drafts edited before approve/send) | Downward trajectory; target [to be filled when a baseline is captured] | **No baseline captured** — `mailbox.drafts.status` distinguishes `approved` vs `edited`, so it is measurable from existing data |
| SM-99 | Cloud-call rate (fraction of drafts routed to cloud) | Downward trajectory toward per-customer sunset (§1 criterion 1) | **No baseline captured** — derivable from `drafts.model` colon convention (cloud vs local path) |

---

## §8. New Decision Records

Numbers assigned from the registry high-water mark **DR-58** (multi-provider addendum). The MBOX-119 "next would be DR-22" note is stale. Note the **existing DR-21 double-assignment** (cloud-doctrine vs t2-model-candidates, both 2026-05-13) flagged for reconciliation in the registry — not reused here.

### DR-59: T2 base drafter = `qwen3-4b-instruct-2507` (Accepted)

**Decision:** Adopt Ctrl-B `qwen3-4b-instruct-2507` (Q4_K_M GGUF) as the production T2 local drafter, served via llama.cpp. Flips the long-double-assigned DR-21 "t2 model acceptance gate" to a settled model selection.

**Type:** Architectural | **Date:** 2026-05-18 (MBOX-112 Delivered) | **Status:** Accepted

**Alternatives considered:**

| Option | Trade-off | Why rejected |
|---|---|---|
| Nemotron 3 Nano 4B (C1) | New arch; license cleared (MBOX-139) | OOM mid-sweep on 8 GB |
| Qwen3.5-4B (C2) | New arch | OOM mid-sweep on 8 GB |
| Gemma 4 E4B (C3) | High draft quality | Kernel-OOM at trace 11; prime candidate at M5 16 GB+ |

**Rationale:** 2.77× function-call validity (26.5%→73.5%), p50 latency halved (16.7s→10.2s) at parity throughput (15.4 vs 16.0 t/s), within the 8 GB envelope. 5/6 acceptance gates pass; gate 2 (blind-pref) pending (SM-96). **Consequences:** new-arch comparison deferred to 16 GB+ hardware; any future LoRA (§4) must train on this base.

### DR-60: Draft quality lever is the model, not the prompt — prompt-optimization deprioritized (Accepted)

**Decision:** Treat prompt-graph optimization (DSPy GEPA) as a closed, negative result for the current base; do not invest further GEPA effort against Qwen3-4B. Future quality gains come from model selection, personalization layers, and structural decoding — not prompt search.

**Type:** Strategic | **Date:** 2026-05-18 (MBOX-114 Delivered) | **Status:** Accepted

**Rationale:** GEPA returned +0.000 lift across three runs (strict judge v1.0; relaxed judge v1.0; relaxed judge v1.1) even after the judge-metric relaxation and 429-backoff fixes (MBOX-114). The relaxed metric reduced 429-exhaustion 73.8%→51.0% but surfaced no prompt lift. **Consequences:** routes the win-rate problem to the bake-off (DR-59) and to personalization (§4/§5). The DSPy harness + relaxed metric remain as a regression instrument, not an optimizer.

### DR-61: Per-customer personalization sequenced cheapest-first; LoRA is last and gated, not committed (Candidate)

**Decision:** Personalization is pursued cheapest-first — retrieval-augmented few-shot (MBOX-115) and style vectors (MBOX-118) before LoRA (MBOX-116). LoRA is a **Candidate**, explicitly "possibly never," and must not block Phase 2.

**Type:** Strategic | **Date:** 2026-05-29 | **Status:** CANDIDATE — gated on the MBOX-118 / MBOX-115 blind-pref result (SM-97)

**Kill criterion:** if MBOX-115 + MBOX-118 together deliver blind-pref win rate ≥ 50% over base on the §5.8 trace set, **defer LoRA to Phase 3 / M6+** and reallocate the 4-8 weeks.

**Confidence:** Medium — directional input (`memo-style-vectors-vs-lora`) favors style vectors as the Phase 2 wedge, but rests on unmeasured on-device evidence. **Rationale:** LoRA is the most expensive path and the strongest privacy story ("the doctrine line"); the doctrine's sunset criterion #2 (§1) depends on it, but committing to it before the cheaper paths are evaluated would over-spend. **Affects:** §1 sunset criterion 2, §4, §5.

### DR-62: M4 inference-technique spikes ship code OFF, gated on on-device A/B (Candidate)

**Decision:** Style-vector steering (MBOX-118) and constrained decoding (MBOX-120) land as **off-by-default, evidence-gated** spikes. Neither is promoted to a live default without an M1 blind-pref / latency measurement.

**Type:** Architectural | **Date:** 2026-05-29 | **Status:** CANDIDATE — gated on on-device A/B (§6.2)

**Kill criteria:**
- Style vectors: <15 t/s on T2 (SM-60 floor) = dead; also blocked on the no-hidden-state-hook problem in llama.cpp (needs fork / C++ plugin).
- Constrained decoding: `CONSTRAINED_DECODING_ENABLED` stays default OFF until the on-device reorder/scheduling A/B shows the grammar helps; also blocked on the `@umb-advisors/llm` NO-OP grammar mapping (needs package bump).

**Confidence:** Low — both feasibility flags (hidden-state hook; grammar field mapping) are unresolved. **Rationale:** banks the implementation work without risking draft quality on unmeasured changes; preserves the "no fabricated win-rates" discipline. **Affects:** §6.2, SM-97.

---

## §9. Open Questions

| # | Question | Section | Impact |
|---|---|---|---|
| NC-39 | Skill/few-shot vs LoRA reconciliation — which is the committed personalization layer once on-device evidence exists? | §5 | Determines whether MBOX-116 LoRA is built or permanently deferred |
| NC-40 | Few-shot exemplar seed gap — M1 `sent_history` is 441/444 `unknown`, so category exemplars don't fire; how is the corpus seeded (STAQPRO-357 sub-task 2)? | §2, §6.3 | Blocks both MBOX-115 dynamic exemplars and any corpus-derived grammar (MBOX-120) |
| NC-41 | New-architecture re-bake-off on 16 GB+ hardware (M5) — does Gemma 4 E4B / Nemotron / Qwen3.5 beat `qwen3-4b-instruct-2507` once the OOM envelope lifts? | §3, DR-59 | Could reopen DR-59 at M5 |

---

## Cross-References / Sources

- DR/SM/NC registry, doctrine, conventions — GATHER outputs (numbering registry; cloud-use-doctrine summary).
- DR-21 doctrine: `docs/addendum-cloud-use-doctrine-v0_1-2026-05-13.md` (MBOX-117 / STAQPRO-337).
- DR-21 model gate: `docs/addendum-t2-model-candidates-v0_1-2026-05-13.md`.
- Bake-off: MBOX-112; PRs #111/#112; `docs/plan-staqpro-342-bakeoff-v0_1-2026-05-16.md`; `project_dr21_v5_verdict.md`.
- GEPA: MBOX-138 / MBOX-114; `optimization/dspy/README.md`; PRs #83/#86/#99/#101/#110.
- License: MBOX-139; `docs/memo-nemotron-license-review-v0_2-2026-05-14.md`; PR #85.
- Quick wins: MBOX-140; `docs/addendum-drafting-prompt-audit-v0_1-2026-05-16.md`; PR #81.
- Eval harness: MBOX-121 / MBOX-135; PRs #82/#98/#108.
- llama.cpp / DR-25: MBOX-136; PR #84; `project_dr25_cutover_landed.md`; CLAUDE.md.
- Retrieval few-shot: MBOX-115; PR #164.
- LoRA: MBOX-116 (STAQPRO-344). Style vectors: MBOX-118 (PR #179, off-device). Constrained decoding: MBOX-120 (PR #183, merged to master 2026-05-29). Critic: MBOX-144. KV cache: MBOX-145. b5283 upgrade: MBOX-334.

---

## Provenance footer — MBOX-111 children status as of 2026-05-29

| Child | Workstream | Status (2026-05-29) | Documented in this draft as |
|---|---|---|---|
| MBOX-112 | Three-way T2 bake-off (DR-21) | Delivered | §3 Accepted (DR-59) |
| MBOX-114 | DSPy relaxed judge + 429 backoff | Delivered | §3 / DR-60 Accepted |
| MBOX-115 | Retrieval-augmented few-shot | Delivered (plan only — no runtime code) | §6.3 Candidate |
| MBOX-116 | Per-customer LoRA personalization | BACKLOG / unstarted | §4 Candidate (NOT BUILT) |
| MBOX-117 | Cloud-use doctrine | (doctrine source — DRAFT, pending Eric/Kevin) | §1 restated |
| MBOX-118 | Style-vector spike | In Development (code off-device, PR #179; NOT Delivered) | §6.2 Exploratory (DR-62) |
| MBOX-120 | Constrained-decoding spike | In Development (code **merged to master via PR #183** 2026-05-29, flag OFF; package bump + on-device eval pending; NOT Delivered) | §6.2 Exploratory (DR-62) |
| MBOX-121 | §5.8 eval harness + trace set v1.0 | Delivered | §2/§3/§6 (eval instrument) |
| MBOX-135 | Trace-set v1.1 corpus-quality filter | Delivered | §3 (Run-3 corpus) |
| MBOX-136 | llama.cpp migration on T2 (DR-20/DR-25) | Delivered | §2 Accepted (live runtime) |
| MBOX-138 | DSPy GEPA baseline | Delivered | §3 / DR-60 Accepted |
| MBOX-139 | Nemotron license review | Delivered | §3 Accepted (license PASS) |
| MBOX-140 | Prompt + context quick wins | Delivered | §2 Accepted |
| MBOX-144 | Generator + Critic loop | BACKLOG | §6.3 Candidate |
| MBOX-145 | Host-memory KV cache (persona prefix) | In Development | §6.3 Candidate |
| MBOX-334 | llama.cpp b5283 → #20574 upgrade | BACKLOG (Low) | §6.3 Exploratory |
| MBOX-119 | This close-out addendum | BACKLOG (this artifact) | — |

**Boundary — this draft documents X, defers Y.**
This v0_1 draft **documents** the settled draft-quality work: the DR-21 model verdict (DR-59), the "model not prompt" finding (DR-60), the live post-quick-wins / post-migration pipeline (§2), the eval harness, the license clearance, and the doctrine restatement with sunset criteria (§1). It **defers** — and does not close — everything gated on on-device evidence: the LoRA build (MBOX-116), the skill/LoRA reconciliation (§5 / NC-39), the two M4 spikes (MBOX-118 / MBOX-120, DR-62), the generator+critic loop (MBOX-144), and the latency KV-cache work (MBOX-145 / MBOX-334). **MBOX-111 remains OPEN** until MBOX-116 and MBOX-144 are resolved; this addendum must be promoted to a final close-out (v1_0) only after those land.
