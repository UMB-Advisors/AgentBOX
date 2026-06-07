# T2 Model Candidates Addendum v0.1.0

**Status:** v0.1.0 — first version checked into the mailbox repo. STAQPRO-340 references an earlier `addendum-t2-model-candidates-v0_1-2026-04-25.md` that does not exist in this repo (likely authored in a sibling planning doc or never made it into git). This v0.1.0 is the fresh mailbox-repo version of that addendum, dated to the start of M5 draft-quality work.

**Tracks:** STAQPRO-340 (this work — eval harness + trace set v1.0). Parent: STAQPRO-336 (M5 draft-quality roadmap). Closely related: STAQPRO-342 (three-way model bake-off), STAQPRO-343 (DSPy GEPA), STAQPRO-344 (per-customer LoRA), STAQPRO-338 (DR-20 llama.cpp prerequisite), STAQPRO-339 (Nemotron license review).

## DR-21 — T2 model acceptance gate

A candidate local-route drafter (post-bake-off in STAQPRO-342) ships only when **all** of the following hold, measured against the v1.0 trace set:

| Criterion | Threshold | Source |
|---|---|---|
| Function-calling fidelity | ≥ baseline (qwen3:4b-ctx4k) | STAQPRO-340.3 placeholder — current pipeline doesn't expose tool calls; metric is a placeholder until the function-calling drafter ships. |
| Draft quality (judge_score) | non-regressive vs. baseline (Δ ≥ 0 with 90% CI excluding 0) | `dashboard/lib/drafting/judge.ts` voice+facts+length sum (range 0–9), measured via `--judge=haiku` over the full v1.0 trace set. |
| Throughput | ≥ 15 t/s mean (preferably median ≥ 15) | `tokens_per_second_aggregates` in the harness report. Source: Ollama's `eval_count / eval_duration` fields. |
| Peak GPU memory | ≤ 3.4 GiB at 4K context | External: `nvidia-smi --query-gpu=memory.used --loop-ms=500` poll during the harness run. Harness does not capture this directly (Jetson `tegrastats` is the production-side equivalent). |
| License | unambiguously usable for UMB commercial distribution | STAQPRO-339 (Nemotron) and equivalent legal reviews for the other candidates. |
| Tooling friction | no new tooling beyond DR-19 (llama.cpp build) / DR-20 (llama.cpp migration on T2, STAQPRO-338) | Reviewer judgment at PR time. |

The long-context tier (8K/16K) **may relax the 3.4 GiB cap** depending on what STAQPRO-340.1 reveals about the candidates' KV-cache growth profiles. The other criteria hold across both tiers.

## v1.0 trace set — locked decisions

| Decision | Locked value | Rationale |
|---|---|---|
| Source corpus | `mailbox.sent_history WHERE source='backfill'` on customer #1 (mailbox1). Joined to `mailbox.inbox_messages` on `inbox_message_id`. | Real-customer pairs with human-written replies — the closest available proxy for "preferred output." 441 pairs exist; v1.0 takes n=50 stratified by classification. |
| Workflow categories | `draft-reply` only (v1.0). | The other three (`classify-and-file`, `summarize-thread`, `escalate-to-human`) require synthetic data or human labeling. Deferred to STAQPRO-340.2. |
| PII scrub policy | Phone, SSN, 16-digit card → tokens. Email addresses, URLs, names retained. | STAQPRO-193 locked decision. `lib/rag/scrub.ts` is the single source of truth — the build script reuses it verbatim. |
| Committed-to-git | Manifest schema + build script + README. NOT the JSONL itself. | Project privacy constraint: "All email content stored only on local appliance." Even PII-scrubbed bodies bar a public-repo commit. Operator regenerates the JSONL on workstation per the v1.0 README. |
| Canonical JSON | Keys sorted alphabetically; two-space indent; trailing newline. | Deterministic SHA-256 across machines + Node versions. Not full JCS / RFC 8785 — robust enough for offline eval integrity, not cryptographic non-repudiation. |
| Manifest hash | `set_sha256 = sha256(sorted-concat-of-per-trace-sha256s)`. Sort key: `inbox_message_id`. | Order-independent — the same content yields the same manifest hash no matter what order the build script processed rows in. |
| Filename | `<first-16-hex-chars-of-trace-sha256>.trace.json` | Content-addressed; short enough for tab completion; collision-free at n≪4B. |

## v1.0 deliverable (this PR)

Shipped under STAQPRO-340:

- `dashboard/lib/eval/trace-set.ts` — pure module: types, canonical JSON, manifest, zod schemas, integrity verifier.
- `dashboard/scripts/build-trace-set.ts` — CLI exporter from live appliance Postgres.
- `dashboard/scripts/rag-eval-harness.ts` extension — `--trace-set <dir>` and `--run-tag <tag>` flags; per-pair perf metrics (latency_ms, tokens_in, tokens_out, tokens_per_second); perf aggregates on the report.
- `dashboard/eval/t2-traces/v1.0/` — README, manifest.example.json, `.gitignore` (excludes the JSONL).
- `dashboard/test/lib/trace-set.test.ts` — unit tests for canonical JSON, manifest determinism, zod rejection.
- `dashboard/test/lib/rag-eval-harness.test.ts` — extended with parseArgs / buildReport / generateDraft perf-metrics + run-tag tests.
- `docs/runbook/rag-eval.v0.5.0.md` — additive runbook update on top of v0.4.0.

## Sub-issues (open as Linear sub-issues from this PR)

| Sub-issue | Title | Why it's deferred |
|---|---|---|
| STAQPRO-340.1 | v1.1 long-context (8K / 16K) trace tier | Current customer #1 corpus rarely hits 8K in a single inbound. Requires assembling 8K+ email-thread inputs (concatenating quoted history) and/or a larger corpus. |
| STAQPRO-340.2 | Synthetic / labeled traces for the three non-draft-reply categories | Requires either operator-driven manual labeling on the live appliance or LLM-synthesized data with a labeling pass — both gated on operator approval. |
| STAQPRO-340.3 | Function-call validity metric | Depends on the live drafter exposing tool calls. Current pipeline is pure free-form generation; function-calling adoption tracks under a separate roadmap item. |

## First baseline run

After the operator runs `npx tsx scripts/build-trace-set.ts` against mailbox1 and `npx tsx scripts/rag-eval-harness.ts --trace-set eval/t2-traces/v1.0 --judge=haiku --run-tag eval-qwen3-4b-ctx4k-2026-05-13-baseline`, the resulting JSON in `dashboard/eval-results/` is the **reference baseline** for the bake-off (STAQPRO-342). All three candidate models hit the same set and their reports are compared row-by-row in the STAQPRO-342 closing comment.

## What did NOT change

- The DB-driven path in `rag-eval-harness.ts` is unchanged. Existing operators running the v0.4.0 runbook (H5/H3 sweep, etc.) keep working with no flag changes.
- `lib/drafting/judge.ts` is unchanged — same haiku + gpt-oss providers, same 0–9 scoring.
- `lib/rag/scrub.ts` is unchanged — reused verbatim by the build script.
- The 4 n8n workflow JSONs are unchanged. This is dashboard-side only.
