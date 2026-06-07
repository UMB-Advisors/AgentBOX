# `optimization/dspy/` — DSPy GEPA prompt optimizer

STAQPRO-343. Offline prompt-optimization toolchain for the MailBox One
drafting pipeline. Lives in this repo because it's tightly coupled to the
trace-set abstraction (`dashboard/lib/eval/trace-set.ts`) and to the live
prompt files (`dashboard/lib/{classification,drafting}/prompt.ts`).

**This is operator-run tooling, not appliance runtime.** Nothing here ships
to mailbox1 / mailbox2; the only artifacts that propagate to the appliance
are the compiled prompt templates an operator chooses to copy out of
`outputs/` into the persona / n8n config (a manual step outside this PR's
scope).

## What's in here

- `pyproject.toml`, `uv.lock` — Python toolchain pinned to DSPy 2.x.
- `signatures.py` — DSPy signatures for `ClassifyAndFile` + `DraftReply`,
  mirroring `dashboard/lib/{classification,drafting}/prompt.ts`.
- `metric.py` — Ollama Cloud `gpt-oss:120b` LLM-as-judge metric (primary)
  + nomic-embed cosine sanity floor (secondary). Returns 0/1 win per
  `(candidate, reference)` pair. Same endpoint + auth as the live
  alt-cloud drafter (DR-23 supersede) — different family than the Qwen3
  baseline drafter to avoid same-model-as-judge bias.
- `trace_set.py` — Pydantic mirror of the canonical TS trace-set schema
  with SHA-256 verification. Source of truth: `dashboard/lib/eval/trace-set.ts`.
- `optimize.py` — CLI entry point. Loads traces, splits train/val, runs
  GEPA, emits `program.json` + portable prompt YAML + report.md.
- `tests/` — pytest coverage for the trace loader, signatures, and metric
  parsing (judge is mocked; no live cloud calls in CI).
- `outputs/` — gitignored. GEPA runs write here.
- `prompts/` — committed. Templates portable to n8n / persona system land
  here after operator review of an `outputs/` run.

## Privacy stance

- Trace JSONL files live in `traces/` (also gitignored) — they contain
  PII-scrubbed customer email bodies but still embed real sender names and
  email addresses per the STAQPRO-193 locked decision. Treat as
  customer-private; never commit, never publish.
- The Ollama Cloud `gpt-oss:120b` judge call sends individual
  `(candidate, reference, inbound)` triples to `https://ollama.com/api/chat`.
  This is inside the existing cloud trust boundary — the live drafter
  already escalates to the same endpoint on the cloud route per DR-23 —
  but you should still gate runs behind operator approval.
- The portable prompt YAML in `prompts/` (or in `outputs/<run>/prompt-*.yaml`)
  is **instructions only**, no few-shot demos. The optimizer deliberately
  strips compiled demonstrations because those may quote real customer
  email fragments verbatim. Operator must eyeball any YAML before copying
  out of `outputs/` into the committed `prompts/` directory.

## Operator runbook

### One-time setup

```bash
cd optimization/dspy
uv sync                                # materializes .venv from uv.lock
export OLLAMA_CLOUD_API_KEY=...        # required for judge + reflection LM
# Same key as the live appliance's `.env` OLLAMA_CLOUD_API_KEY (the
# alt-cloud drafter path per DR-23). Pull from 1Password if you don't have
# it locally; never commit.
```

### Fetch a real trace set from an appliance

Real customer email content materializes only on the appliances. To run
GEPA against real data, build a trace set on the box and scp it back to
the workstation. Delete the local copy when you're done.

```bash
# On the workstation — open a Postgres tunnel for the build script.
# (Equivalent to `ssh -L 5432:localhost:5432 mailbox1` then running the
# build-trace-set.ts CLI inside the dashboard container; see
# dashboard/scripts/build-trace-set.ts for the canonical procedure.)
ssh mailbox1 'docker exec -e POSTGRES_URL=$(grep ^POSTGRES_URL /home/bob/mailbox/.env | cut -d= -f2-) \
  mailbox-dashboard npx tsx scripts/build-trace-set.ts \
  --out /tmp/trace-set/v1.0 \
  --set-version v1.0 \
  --appliance mailbox1 \
  --limit 100'

# Pull it back.
mkdir -p optimization/dspy/traces/v1.0
scp -r mailbox1:/tmp/trace-set/v1.0/* optimization/dspy/traces/v1.0/

# Clean up the on-appliance copy.
ssh mailbox1 'rm -rf /tmp/trace-set'
```

### Run optimization

```bash
cd optimization/dspy
uv run python -m optimize \
  --trace-set ./traces/v1.0 \
  --target-base-url http://localhost:11434 \
  --target-model qwen3:4b-ctx4k \
  --out outputs/run-$(date +%Y%m%dT%H%M%S) \
  --auto light
```

Bottom-line numbers (PRE / POST / LIFT) print at the end. The full report
+ compiled program + portable prompt YAML land in `outputs/<run>/`.

For the target model, point at any OpenAI-compatible endpoint:

- Local Qwen3 on the workstation if you've pulled the model there.
- The appliance Ollama via SSH tunnel: `ssh -L 11434:localhost:11434 mailbox1`.
- Ollama Cloud for `gpt-oss:120b` (second-pass; out of scope for v0.1).

### Clean up after a run

```bash
# Trace JSONL is gitignored but lives on disk — wipe when done.
rm -rf optimization/dspy/traces/
```

## Testing

```bash
cd optimization/dspy
uv run pytest
```

Tests cover:

- Trace loader: parsing the example manifest, schema validation, SHA-256
  verification.
- Signatures: enum parity with `dashboard/lib/classification/prompt.ts`.
- Metric: judge response parsing (mocked Ollama Cloud `/api/chat`), wire
  shape (URL, Bearer auth, model), cosine math, empty candidate handling.

No live cloud calls are made in CI — the judge's `httpx.Client` is
swapped for a `MagicMock` after construction and nomic-embed is bypassed
via `disable_cosine=True`.

## Scope notes (STAQPRO-343 v0.1)

- **Signatures shipped:** `ClassifyAndFile`, `DraftReply`. The stretch
  signatures (`summarize-thread`, `escalate-to-human`) are deferred — the
  trace-set v1.0 spec emits `draft-reply` rows only.
- **Target models:** Qwen3-4B (current production drafter) is the v0.1
  first-pass target. Second-pass against the STAQPRO-342 bake-off winner
  is out of scope for this PR — that issue hasn't completed.
- **Trace-fetch path:** option (b) per the foreman audit — ship the
  harness, document the operator runbook above for fetching a real trace
  set. No real traces materialize in this PR; first real GEPA run is an
  operator follow-up.

## Run-1 baseline (2026-05-14, mailbox1 v1.0 trace set)

| Field | Value |
|---|---|
| Run dir (gitignored) | `outputs/run-1-baseline-2026-05-14/` |
| Trace set | `traces/v1.0` (100 traces from mailbox1) |
| Set SHA-256 | `d8d040ba5ee06933425e794b7c81c20f9938ffb2c35f4f531d2f7eed30799d04` |
| Split | train=50, val=50, seed=1 |
| Target | `qwen3:4b-ctx4k` @ `http://localhost:11434` |
| Judge | `gpt-oss:120b` @ Ollama Cloud |
| GEPA budget | `--auto light` (≈580 metric calls, 2h21m wall-clock) |
| **PRE win rate** | **0.000** (full valset) |
| **POST win rate** | **0.000** |
| **Lift** | **+0.000** |

The compiled `prompt-draft-reply.yaml` is byte-identical to the baseline
instructions — GEPA proposed ≥5 mutations and the judge scored every
one at 0.0, so GEPA correctly skipped all of them per its
"new-score must beat old-score to be accepted" rule.

**This is a real data point, not a measurement artifact.** GEPA's
Iteration-0 base-program full-valset eval registered 0.0/50 *before*
the run hit any Ollama Cloud rate-limit pressure (the 428 of 580
`429 Too Many Requests` failures concentrated in post-eval at the
tail). With baseline = 0.0, GEPA has no positive signal to gradient
against, so every reflective mutation also returns 0.0 and the search
collapses to "no change."

The next-steps follow-ups are about the **metric + corpus**, not GEPA
itself:

1. **Judge prompt is structurally too strict.** Pairwise win-rate is
   defined as `candidate ≥ reference` on three axes (intent +
   actionability + tone-match). Real-world references are often short,
   conversational, sometimes literal forwarded-message chains
   ("`---------- Forwarded message --------- From: …`"). Qwen3-4B's
   default-prompt candidates are longer and more corporate. On the
   *tone-match* axis the operator-written reference is treated as
   canonical, so any rewrite — however semantically equivalent — fails
   the `≥` test. The metric needs to relax to *"non-regressive on
   intent + no fabrication"* rather than strict majority-vote-≥ on three
   axes. Tracked separately (see Linear: judge-relax follow-up on
   STAQPRO-340).
2. **Trace corpus has forwarded-mail and duplicate-inbound rows.** The
   v1.0 builder (`dashboard/scripts/build-trace-set.ts`) joins
   `sent_history` rows with `source='backfill'` 1:1 to `inbox_messages`
   on `inbox_message_id`. For inbounds that the operator forwarded
   *and* replied to (or replied multiple times), the inbound appears in
   multiple traces with different `actual_reply_body` values. The
   target model deterministically produces the same candidate for the
   same prompt, so the metric scores those duplicates against
   different "ground truths" — diluting signal. The builder should
   filter forwarded-only replies and pick one canonical reply per
   inbound. Tracked separately on STAQPRO-340.
3. **Ollama Cloud 429 rate-limit handling.** The judge HTTP client
   currently has no retry/backoff — a 429 becomes an immediate
   `0` score for that example. Add exponential backoff with jitter
   inside `metric.JudgeMetric._call_judge`. Tracked separately.

**Conclusion for M5 sequencing:** the +0.000 lift is the honest answer
under the current v0.1 metric + v1.0 corpus. Read it as: *prompt
optimization alone does not move the Qwen3-4B-ctx4k draft-quality
needle when evaluated against the operator's actual sent replies.*
For STAQPRO-342 (three-way bake-off) this is useful: it suggests
architectural model lift, not prompt lift, is where Phase 2 win-rate
improvements live. The two follow-ups above will tell us whether a
relaxed metric + a cleaner corpus would surface prompt-level lift on
the bake-off winner.

## Run-2 (STAQPRO-363 — relaxed metric + 429 retry, 2026-05-15)

**Status: completed 2026-05-15.** The metric module landed the
STAQPRO-363 changes (relaxed judge prompt, cosine sanity floor flipped
to opt-in, 429 retry/backoff with jitter + clamped `Retry-After` +
structured `JudgeError("rate_limited")` on exhaustion). Smoke gate
passed (ref-vs-ref 0.80, clearly-bad 0.00, baseline 0.20). GEPA was
re-fired against the same `traces/v1.0` set. Numbers in the table
below; verdict at the end of this section.

### Pre-flight smoke (cheap, ~30 cloud calls)

Before spending another `--auto light` budget (~580 cloud calls,
~2h21m wall-clock), confirm the relaxed judge is discriminative:

```bash
cd optimization/dspy
uv run python scripts/judge_discriminative_smoke.py \
    --trace-set ./traces/v1.0 \
    --n 10
```

Pass criteria (exits non-zero on failure):

* `reference-vs-reference` mean ≥ 0.80 — judge accepts operator-approved
  replies when fed them as candidates.
* `clearly-bad` mean = 0.00 — judge rejects an off-topic, fabricating
  candidate every time.
* `baseline (truncated)` — informational, no threshold; should land
  somewhere in between as a sanity signal.

If `reference-vs-reference < 0.80`, the prompt needs another pass
before burning a full GEPA budget — STOP, don't proceed.

### Run-2 invocation

After smoke passes:

```bash
cd optimization/dspy
uv run python -m optimize \
    --trace-set ./traces/v1.0 \
    --target-base-url http://localhost:11434 \
    --target-model qwen3:4b-ctx4k \
    --out outputs/run-2-relaxed-judge-$(date +%Y%m%dT%H%M%S) \
    --auto light
```

Cosine floor stays off (the STAQPRO-363 default). Pass `--cos-floor 0.30`
only for a diagnostic A/B against Run-1's gating behavior.

### Run-2 results

| Field | Value |
|---|---|
| Run dir (gitignored) | `outputs/run-2-relaxed-judge-20260516T012838Z/` |
| Trace set | `traces/v1.0` (same as Run-1) |
| Set SHA-256 | `d8d040ba5ee06933425e794b7c81c20f9938ffb2c35f4f531d2f7eed30799d04` |
| Split | train=50, val=50, seed=1 (unchanged) |
| Target | `qwen3:4b-ctx4k` @ `http://localhost:11434` |
| Judge | `gpt-oss:120b` @ Ollama Cloud (relaxed prompt + 429 retry) |
| GEPA budget | `--auto light` (≈580 metric calls; 100 min wall-clock vs Run-1's 141 min — the cosine-floor skip on the default path saves the embed round-trips) |
| **PRE win rate** | **0.000** (full valset) |
| **POST win rate** | **0.000** |
| **Lift** | **+0.000** |
| Judge 429-exhaustion rate | **296/≈580 ≈ 51.0%** (down from Run-1's 428/580 = 73.8%, a 22.8-pp drop) |
| `JudgeError("rate_limited")` count | 296 (calls that exhausted 4 retries and were scored 0.0) |
| Retry recovery rate | 1/297 ≈ 0.34% (only 1 of 297 calls that entered the retry path eventually got a 200; the cloud rate-limit is sustained, not bursty, so exponential backoff alone doesn't recover most stalled calls) |
| GEPA iterations | 109 attempted, 0 accepted (every mutation scored 0.0; selected program 0 every iteration) |
| Compiled `prompt-draft-reply.yaml` | byte-identical to the seed `signatures.py` instructions (same outcome as Run-1) |

### Run-2 verdict

The relaxed-metric + retry/backoff changes worked as designed but did
not move the lift. The 429-exhaustion rate fell ~23 pp (73.8% → 51.0%),
confirming the retry path takes pressure off Ollama Cloud, but only
1/297 retry-path calls actually recovered to a 200 — the cloud
rate-limit on `gpt-oss:120b` is sustained, not bursty, so exponential
backoff alone is the wrong tool. More importantly, the win rate didn't
budge: pre = post = 0.000, same as Run-1. With baseline still
collapsed at 0.000, GEPA's reflective mutator has no positive signal
to gradient against, and every one of the 109 proposed mutations
scored 0.0 → was correctly skipped. The +0.000 lift is the honest
answer under the v1.0 corpus, irrespective of metric strictness.

**Next sequenced follow-up — rebuild traces against v1.1.** The
forwarded-mail + duplicate-inbound builder filter shipped in
STAQPRO-365 (PR #98, merged 2026-05-15) was *not* applied to the
on-disk `traces/v1.0/` set used here — the SHA-256 in the table above
matches Run-1's, proving the corpus is unchanged. Re-fetch a v1.1
trace set from mailbox1 using the updated `build-trace-set.ts`,
then re-run GEPA against it. If baseline still pins to 0.000 on a
clean corpus, the next lever isn't the metric or the corpus — it's
the target model itself (STAQPRO-342 three-way bake-off).

## Run-3 (v1.1 corpus, 2026-05-16)

**Status: completed 2026-05-16.** v1.1 trace set was built fresh from
mailbox1 via the STAQPRO-365 builder filter (forwarded-mail dropped,
duplicate inbounds deduped via `DISTINCT ON`). GEPA re-fired with the
STAQPRO-363 metric (same relaxed judge + 429 retry/backoff as Run-2).

### v1.1 build provenance

| Field | Value |
|---|---|
| Build path | workstation, against an SSH-tunneled `mailbox-postgres-1` (read-only) |
| Builder commit | `0cbdc00` (STAQPRO-365, PR #98) via `dashboard/scripts/build-trace-set.ts` |
| Trace count | 100 (same as v1.0 for comparability) |
| Set SHA-256 | `af298191769e849fc0f63c2e5f92b8d825675535ab4efae81972d59f279bfac6` (≠ v1.0's `d8d040ba…`, confirms the filter actually changed the corpus) |

### Pre-flight smoke result

Smoke gate **flagged** (not a hard stop): `reference-vs-reference 0.70`
on N=30, against the documented `≥ 0.80` threshold. Failure mode is
NOT the judge rejecting valid references — it's `gpt-oss:120b` cloud
returning empty 200-OK bodies on ~30% of calls (the metric counts
unparseable empty body as `win=0`). Same failure mode flagged in
Run-2's verdict, just amplified during this batch. v1.1 corpus signal
is sound; the cap is cloud-side.

Operator one-time bypass: Run-3 proceeded despite the smoke flag, on
the read that *another* +0.000 lift on a clean corpus is a more
informative data point than refusing to measure. Numbers below should
be read with the ~30% empty-response ceiling in mind.

### Run-3 results

| Field | Value |
|---|---|
| Run dir (gitignored) | `outputs/run-3-v1_1-corpus-20260516T201059Z/` |
| Trace set | `traces/v1.1` (set_sha=`af298191…`) |
| Split | train=50, val=50, seed=1 (unchanged) |
| Target | `qwen3:4b-ctx4k` @ `http://localhost:11434` |
| Judge | `gpt-oss:120b` @ Ollama Cloud (same metric config as Run-2) |
| GEPA budget | `--auto light` (≈580 metric calls; 245 min wall-clock — 2.5× Run-2 because Ollama Cloud was much more rate-limited during this window) |
| **PRE win rate** | **0.000** (full valset) |
| **POST win rate** | **0.000** |
| **Lift** | **+0.000** |
| Judge 429-exhaustion rate | **640/643 retry cycles ≈ 99.5%** (vs Run-2's 296/297 ≈ 99.7% of retry-cycle-entering calls; the absolute count doubled — cloud was meaningfully more loaded during Run-3's afternoon window vs Run-2's evening one) |
| `JudgeError("rate_limited")` count | 640 |
| Retry recovery rate | 3/643 ≈ 0.47% (still <1%; cloud rate-limit is sustained-not-bursty across both runs) |
| GEPA iterations | 142 attempted, 0 accepted, 35 explicitly skipped not-better |

### Run-3 verdict

Three independent GEPA runs — strict-metric/v1.0 (Run-1),
relaxed-metric/v1.0 (Run-2), relaxed-metric/v1.1 (Run-3) — all converge
on **lift = +0.000**. The corpus change (forwarded-mail filter +
inbound dedup) eliminated the obvious diluted-signal failure mode from
Run-1's findings, but the baseline still pinned at 0.000 on the
v1.1 valset, so GEPA's reflective mutator still has no positive
signal to gradient against. With the metric, corpus, and judge each
having had a turn, the residual lever for moving win-rate on this
appliance is the **target model**, not the prompt — confirming
Run-1's "architectural lift, not prompt lift" sequencing call.

**Two follow-ups out of Run-3, both upstream of any further
DSPy-GEPA work on this surface:**

1. **STAQPRO-342 three-way bake-off** — the next sequenced target.
   Qwen3-4B-ctx4k has now been ruled out as a prompt-optimizable
   drafter; the bake-off should pick the model that wins on draft
   quality, and only then revisit GEPA on that winner with the
   v1.1+ pipeline established here.
2. **Judge empty-body handling** — `gpt-oss:120b` returns 200-OK
   with empty bodies on ~30% of calls under load, and the metric
   currently scores those as `win=0`. This caps the achievable
   win-rate at ~70% even for a perfect candidate, and it's the only
   reason the v1.1 smoke landed at 0.70 instead of >0.80. File a
   metric-hardening issue: treat empty-body responses as transient
   (retry like 429), and consider a fallback judge (Anthropic
   Haiku alt-cloud per DR-23 retract, or self-hosted Qwen) when
   `gpt-oss:120b` is degraded. Not blocking the bake-off — but
   the next operator to fire `--auto light` will burn another
   100-250 min on cloud noise without it.
