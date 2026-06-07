# RAG Eval Runbook v0.3.0

**Status:** v0.3.0 — adds the LLM-judge mode (STAQPRO-220) alongside the existing cosine-vs-reply scorer. Cosine remains the cheap default; the judge is the second metric for hypothesis tests where cosine has been shown to be metric-limited (see STAQPRO-207 Phase-B inspection).

**Audience:** Operator running offline scoring against the customer-#1 backfilled corpus (441 inbound,reply pairs, 865 Qdrant points as of 2026-05-02).

**Tracks:** STAQPRO-220 (judge mode) + STAQPRO-207 (Phase 2 cosine baseline). Parent track: STAQPRO-122 (M3.5 — RAG over Qdrant). Phase-1 baseline lives in v0.1.0; Phase-2 cosine baseline lives in v0.2.0; this revision documents the judge addition without changing the cosine procedure.

**What changed since v0.2.0:**

- New CLI flags `--judge=<provider>` and `--judge-only=<provider>` on `npm run eval:rag`.
- New per-pair JSON fields (`judge_score`, `judge_voice`, `judge_facts`, `judge_length`, `judge_rationale`, `judge_status`, `judge_error`, `judge_provider`).
- New aggregate blocks (`judge_aggregates_global`, `judge_aggregates_by_category`).
- New status count `judge_failed` so judge outages don't poison the cosine block.
- Cost guardrail and privacy notice for judge calls (cloud — operator-driven).

---

## What this runbook covers

The eval harness scores each historical `(inbound, my_reply)` pair from `mailbox.sent_history` (`source = 'backfill'`). Two scorers run side-by-side when `--judge` is enabled:

1. **Cosine** (always, unless `--judge-only`): draft the inbound via the live `assemblePrompt + retrieveForDraft + pickEndpoint + getPersonaContext` primitives → POST to local Ollama `qwen3:4b-ctx4k` → embed both draft and actual reply via `nomic-embed-text:v1.5` → cosine similarity.
2. **LLM-judge** (when `--judge=<provider>`): send the **draft + actual reply** (NOT the inbound — see §"Judge prompt" below) to the chosen judge provider and parse a structured JSON score on three axes (voice, facts, length).

Mode is still set by env (`RAG_DISABLED=1` for the no-RAG baseline). The judge is orthogonal — runs against whichever cosine mode is active.

---

## Prereqs

| Item | Why | Where |
|---|---|---|
| Appliance reachable over SSH (`jetson` or `mailbox1`) | Container exec | Direct ethernet `10.42.0.2`, or tailnet `mailbox1.tail377a9a.ts.net` |
| `mailbox-dashboard` container running | Same network for the Postgres / Ollama / Qdrant DNS the harness uses | `docker compose ps mailbox-dashboard` |
| Onboarding backfill complete | Empty `sent_history.source='backfill'` means nothing to score | `docs/runbook/onboarding-backfill.v0.1.0.md` |
| Qdrant `email_messages` collection populated | Required only for the with-RAG cosine pass | `curl http://localhost:6333/collections/email_messages \| jq .result.points_count` |
| `qwen3:4b-ctx4k` model pulled | Drafter — required unless `--judge-only` | `docker compose exec ollama ollama list` |
| `nomic-embed-text:v1.5` model pulled | Cosine embedder — required unless `--judge-only` | Same `ollama list` |
| **`ANTHROPIC_API_KEY` set** | Required when `--judge=haiku` | Host `.env`, passed via `-e` to `mailbox-migrate` one-shot |
| **`OLLAMA_CLOUD_API_KEY` set** | Required when `--judge=gpt-oss` | Same |
| **Customer privacy clearance** | Judge sends draft + reply bytes to the cloud provider | See §"Privacy" below — do NOT run `--judge` against a customer corpus that hasn't been cleared |

---

## Running the eval

### Cosine-only (unchanged from v0.2.0)

```bash
ssh mailbox1 'cd ~/mailbox && docker compose --profile migrate run --rm \
  -e POSTGRES_URL=$POSTGRES_URL \
  -e OLLAMA_BASE_URL=http://ollama:11434 \
  -e QDRANT_URL=http://qdrant:6333 \
  mailbox-migrate sh -c "npm install --no-audit --no-fund --silent && \
    npm run eval:rag -- --limit all"'
```

…and the no-RAG counterpart with `-e RAG_DISABLED=1`.

### Cosine + judge (Haiku 4.5 — Anthropic)

```bash
ssh mailbox1 'cd ~/mailbox && docker compose --profile migrate run --rm \
  -e POSTGRES_URL=$POSTGRES_URL \
  -e OLLAMA_BASE_URL=http://ollama:11434 \
  -e QDRANT_URL=http://qdrant:6333 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  mailbox-migrate sh -c "npm install --no-audit --no-fund --silent && \
    npm run eval:rag -- --limit all --judge=haiku"'
```

### Cosine + judge (gpt-oss:120b — Ollama Cloud)

```bash
ssh mailbox1 'cd ~/mailbox && docker compose --profile migrate run --rm \
  -e POSTGRES_URL=$POSTGRES_URL \
  -e OLLAMA_BASE_URL=http://ollama:11434 \
  -e QDRANT_URL=http://qdrant:6333 \
  -e OLLAMA_CLOUD_API_KEY=$OLLAMA_CLOUD_API_KEY \
  mailbox-migrate sh -c "npm install --no-audit --no-fund --silent && \
    npm run eval:rag -- --limit all --judge=gpt-oss"'
```

### Judge-only re-score (skip cosine)

Use case: the cosine numbers are already known (v0.2.0 baseline) and you only need the judge axis on the same corpus. Skips the Qwen3 draft + nomic embed loop entirely (~30-60 min saved per pass), but still runs the drafter to produce the candidate the judge scores against — there's no draft persisted on `sent_history`, so the harness has to generate one to judge it. The flag's value is "skip embed", not "skip everything except judge".

```bash
ssh mailbox1 'cd ~/mailbox && docker compose --profile migrate run --rm \
  -e POSTGRES_URL=$POSTGRES_URL \
  -e OLLAMA_BASE_URL=http://ollama:11434 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  mailbox-migrate sh -c "npm install --no-audit --no-fund --silent && \
    npm run eval:rag -- --limit all --judge-only=haiku"'
```

Per-pair status will be `judge_only` (not `ok`) and `cosine` will be null.

### Limit flag (unchanged)

- `--limit all` — score every backfilled pair.
- `--limit N` — first N pairs ordered by `sent_at ASC`. `--limit 10` is the canonical smoke run (~1 min cosine-only, ~2-3 min cosine+haiku).

### Rate limiting the judge (STAQPRO-224)

`JUDGE_RATE_LIMIT_MS` env var spaces judge calls so a full 441-pair run doesn't burst into Anthropic's 50 RPM standard-tier ceiling:

| Value | When to use |
|---|---|
| `500` (default) | Cosine + Haiku full runs. ~120 RPM theoretical / ~60 RPM after serialized latency. Comfortably under Anthropic standard-tier. |
| `0` | Fast smoke (`--limit 5`) and `gpt-oss` runs (Ollama Cloud has no per-call rate cap that this matters for). |
| `1000+` | Sustained `judge_rate_limited > 0` in stdout summary — raise until the count goes to zero on a 50-pair pilot. |

Pass via `-e JUDGE_RATE_LIMIT_MS=<n>` on the compose-run line (same shape as `ANTHROPIC_API_KEY`). The harness echoes the active pacing at run start. No effect on cosine-only runs.

### Output

Each run writes one JSON file. Filenames now include a judge suffix when judge was enabled:

```
dashboard/eval-results/rag-eval-<ISO-timestamp>-<mode>.json                    # cosine-only (unchanged)
dashboard/eval-results/rag-eval-<ISO-timestamp>-<mode>-judge-<provider>.json   # cosine + judge
dashboard/eval-results/rag-eval-<ISO-timestamp>-<mode>-judge-only-<provider>.json  # judge-only
```

The `eval-results/` directory is gitignored — JSON contains the actual draft + reply bodies + judge rationales.

Stdout summary now lists both metric blocks when judge was enabled:

```
RAG eval — mode=with-rag model=qwen3:4b-ctx4k
pairs: 441 (requested all)  ok=435 draft_failed=2 embed_failed=4 error=0 judge_only=0 judge_failed=3 judge_rate_limited=0

Global cosine similarity:
  count=435  mean=0.7087  median=0.7102  p25=0.6526  p75=0.7684  min=0.4613  max=0.9435

Per-category:
  unclassified     count= 435  mean=0.7087  median=0.7102

Global judge score (provider=haiku, range 0-9):
  count=432  mean=5.234  median=5.000  p25=4.000  p75=7.000  min=0.000  max=9.000
```

---

## Judge prompt (v1)

The judge call is a single chat-shape POST. Same prompt for both providers; only the transport differs (Anthropic `/v1/messages` vs Ollama Cloud `/api/chat`). Source: `dashboard/lib/drafting/judge.ts`.

**System prompt** (verbatim):

> You are an impartial email-quality judge. You return JSON only. You never see the inbound message — only the draft and the actual reply. Score conservatively: a 3 means "essentially the same writer / same facts / same length", and partial matches should land at 1 or 2.

**User message** lays out three axes and the JSON output schema, then attaches `--- DRAFT ---` and `--- ACTUAL REPLY ---` blocks (each soft-clipped at 6000 chars to keep the worst-case input under ~3K tokens).

**Output schema:**

```json
{
  "voice_match": 0..3,
  "factual_alignment": 0..3,
  "length_appropriateness": 0..3,
  "rationale": "one sentence"
}
```

**Why no inbound?** Deliberate per the issue. The question being scored is "does the draft match the operator's actual reply" — not "does the draft answer the inbound." Adding the inbound would lengthen every prompt and slow every call without adding signal for our specific question. If a future eval mode wants the inbound (e.g., scoring "did the draft hallucinate facts the inbound didn't ask for"), that's a new metric in a new module — not this one.

**Aggregate score per pair = sum of the three axes** (range 0-9). Aggregate stats (mean, median, p25/p75, min, max) are computed both globally and per `inbox_messages.classification` bucket, mirroring the cosine block.

**Failure modes** (visible in `per_pair[].judge_status`):

| status | meaning | cosine block | judge block |
|---|---|---|---|
| `ok` | call succeeded, JSON parsed, scores in range | populated | populated |
| `parse_failed` | call succeeded but model output didn't validate (raw retained, capped at 500 chars in `judge_error` / `raw`) | populated | excluded from aggregates |
| `call_failed` | transport error, non-2xx, missing API key | populated | excluded from aggregates |

The `judge_failed` count in `status_counts` is `parse_failed + call_failed`. Tracked separately from `embed_failed` so a judge outage doesn't taint the cosine numbers.

---

## Cost guardrail

### Haiku 4.5 (Anthropic)

- Pricing (2026-05): ~$1/M input tokens, ~$5/M output tokens.
- Per-call shape: ~3K input tokens (system prompt + draft + actual reply, draft + reply soft-clipped at 6000 chars each ≈ 1500 tokens per side) + ~50 output tokens (3 integers + one-sentence rationale + JSON braces).
- Per-call cost: 3000 × $1/M + 50 × $5/M ≈ **$0.003**.
- Full A/B (with-rag + no-rag, 441 pairs each = 882 calls): **~$2.65 per A/B**.
- Smoke run (`--limit 10 --judge=haiku`): **~$0.03**.

This is small enough that the operator running the judge across both passes shouldn't be surprised, but document it in the PR description anyway.

### gpt-oss:120b (Ollama Cloud)

- Fixed-price subscription (Ollama Cloud — not metered per-token).
- Per-call cost: $0 marginal.
- Latency is the constraint, not cost. Expect ~3-5 sec per judge call at the 120b model's throughput.

### Cost-aware patterns

- For Phase-D hypothesis-test runs where the cosine numbers are already known: `--judge-only=haiku` cuts the embed loop. Still pays for the Qwen3 draft (because the harness has to generate the draft to score it), but skips the two nomic embeds per pair.
- For one-off "is the judge metric stable across re-runs" sanity checks: `--limit 50 --judge=haiku` (~$0.15) is enough to read judge variance without spending the full A/B budget.

---

## Privacy

> **Cloud-bound bytes notice:** the judge sends the **draft + actual reply** to whichever cloud provider the operator picked (`api.anthropic.com` for `--judge=haiku`, `ollama.com` for `--judge=gpt-oss`).
>
> The harness logs this on every judge run, but the operator owns the decision. **Do NOT run `--judge` against a customer corpus that hasn't been cleared for cloud transmission.** This includes:
>
> - Customer #1 (`mailbox.heronlabsinc.com`): cleared — Heron's operator approved cloud-route processing in the original setup.
> - Future customers: confirm clearance in the customer's onboarding ticket BEFORE running judge mode against their backfilled corpus.
>
> The inbound itself is NOT sent (per the prompt design) — only the (draft, actual reply) pair. The actual reply is the operator's own outbound, so the surface area is "operator's outbound writing style + Qwen3-generated draft for that thread." For customer-#1 this is acceptable; the operator has explicitly approved cloud drafting on the live pipeline (DR-23 / Ollama Cloud + Anthropic Haiku as the cloud routes).

---

## Known confounds (STAQPRO-223)

Before reading any judge number, internalize the limits of what the judge can actually score.

### `factual_alignment` is contaminated — read it as draft-vs-reply overlap, NOT hallucination

The judge prompt contains both the candidate DRAFT and the operator's ACTUAL REPLY (see §"Judge prompt" above — this is the design, not a bug). When the judge scores `factual_alignment` ("does the draft preserve the reply's facts"), it can trivially achieve a high score by checking whether the draft's text overlaps the reply, not whether the draft's claims are independently true.

In practice this means:

- A draft that **word-copies** the actual reply scores `factual_alignment=3` even if both are wrong.
- A draft that **paraphrases correctly** with different surface words scores lower than the copy-paste version, despite being equally factual.
- Under with-RAG vs no-RAG, **retrieval that pulls the actual reply text into context** (possible — STAQPRO-190 backfilled outbound history into Qdrant) inflates `factual_alignment` for the with-RAG arm by feeding the drafter the answer.

**Operational implication.** Do NOT cite `factual_alignment` deltas as evidence for "RAG reduces hallucinations" until the axis is redesigned (likely a two-pass judge that scores facts without seeing the reply — out of scope here). Conclusions about hallucination drawn from this axis carry an explicit caveat. The other two axes are not similarly contaminated:

- `voice_match` — judges style/tone, doesn't require fact-grounding.
- `length_appropriateness` — judges proportion, doesn't require fact-grounding.

These two should carry the weight when reading a Phase-D hypothesis-test result. `factual_alignment` is a "draft-vs-reply overlap" indicator until the redesign lands.

### `voice_match` does not separate "operator-style" from "operator-historical-words"

A lower-confidence confound. If retrieval pulls the operator's prior responses (which is the whole point of STAQPRO-190 outbound ingestion), the drafter can mimic surface phrasing that the judge then rewards as `voice_match=3`. This is *probably* what we want for production drafting, but it means `voice_match` rewards "uses the operator's word choices" rather than "captures the operator's manner of speaking." Useful signal either way; don't over-read.

---

## Interpreting the numbers

### Cosine — unchanged from v0.2.0

See `rag-eval.v0.2.0.md` §Interpreting. Headline: cosine deltas of ±0.03 are the actionable threshold; per-pair noise (sd ~0.06) is roughly 50× the aggregate effect, so per-packet outlier reading is dangerous (STAQPRO-207 Phase-B confirmed sign-flips on re-run with identical inputs).

### Judge — what it adds

The judge is hypothesized to move where cosine can't:

- **`judge_voice` (voice_match axis)**: H2 (operator outbound voice priming, STAQPRO-221) hypothesizes voice transfer happens at the *style* layer — same facts, same length, but tone shifts. Cosine over a 768-dim embedding can't see this; the judge's `voice_match` axis can.
- **`judge_facts` (factual_alignment)**: catches hallucination — drafts that confidently state facts the actual reply doesn't have. Useful when retrieval starts pulling stale or wrong-counterparty context.
- **`judge_length`**: catches "too short / too long" failure modes that cosine treats as semantic difference. A draft that's 3× the reply's length will score low on length even if the words overlap heavily.

### Decision rule (Phase-D hypothesis tests)

When running with-RAG vs no-RAG WITH `--judge=haiku`, the joint signal lives in the delta of `judge_score` global mean alongside the cosine delta:

| cosine Δ | judge Δ | interpretation |
|---|---|---|
| ≥ +0.03 | ≥ +0.5 | RAG is unambiguously helping. Both metrics agree. |
| ≥ +0.03 | < 0 | Cosine sees retrieval surfacing matched language but the judge sees a regression on voice/facts/length. Investigate which axis dropped. |
| ≈ 0 | ≥ +0.5 | Voice or formatting effect that cosine can't see. This is exactly the H2 / STAQPRO-221 case. |
| ≤ −0.01 | ≤ −0.5 | RAG is hurting on both axes. Stop and investigate. |
| ≤ −0.01 | ≥ +0.5 | Cosine penalizes retrieval for adding novel-but-correct content; judge approves. Probably acceptable. |

Calibration intentionally not done (issue's out-of-scope guardrail). Track both axes; treat as complementary signals.

### Per-pair drift signals

`status_counts.judge_failed` is the union red flag — if it's > 5% of pairs, something is wrong. Read it together with `judge_rate_limited` (STAQPRO-224) to disambiguate:

- `judge_failed - judge_rate_limited ≈ 0` → the only issue is 429s. Raise `JUDGE_RATE_LIMIT_MS` or rerun at lower `--limit`. The eval is otherwise healthy.
- `judge_failed - judge_rate_limited > 0` → "real" call/parse failures. Inspect `per_pair[].judge_error` (and `judge_status='parse_failed'` entries' `raw` field) for ground truth — likely API key, model regression, or un-parseable output.

Cosine drift signals (`status_counts.draft_failed`, `embed_failed`) are unchanged from v0.2.0.

---

## Customer-#1 baselines

Phase 2 cosine baseline (n=441, 2026-05-04) is in `rag-eval.v0.2.0.md`. Judge-mode baselines will be filled in by the first operator-driven Phase-D run. **No judge baseline has been recorded yet** as of v0.3.0 publication — the smoke run that lands with this revision is `--limit 10 --judge=haiku`, which is below the threshold for "baseline" semantics.

---

## Idempotency + safety

Same as v0.2.0:

- **No DB writes.** Postgres read-only.
- **No Qdrant writes.**
- **Re-run safe.** Each run produces a fresh JSON file timestamped with `generated_at`.
- **Operator privacy.** JSON contains draft + reply bodies + judge rationales. Stay on the appliance — never `scp` to a non-operator-owned machine.

New for v0.3.0:

- **Judge is non-DB-writing.** Judge calls go cloud → harness; results live only in the JSON file. No `mailbox.drafts.judge_*` columns exist (eval-only, per scope).
- **Cancel-safe.** Ctrl-C between pairs leaves the partial-progress per-pair set in memory un-flushed; nothing is persisted DB-side. Re-run is the recovery.

---

## Out of scope (don't let this grow)

- **Live judge in production drafting.** Eval-only. Don't add `judge_status` to `mailbox.drafts`.
- **Multi-judge ensembling.** Single judge per run. If "Haiku says 5, gpt-oss says 7, who's right" becomes a real question, the right answer is human spot-check, not voting.
- **Judge calibration to cosine.** They measure different things by design.
- **Replacing cosine.** Cosine stays as the cheap default; judge is the additional signal where cosine is metric-limited.
- **A/B mode flag on the script.** Two `RAG_DISABLED` invocations remains the contract.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Every pair `judge_status=call_failed` with "ANTHROPIC_API_KEY not set" | Env didn't propagate | Add `-e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY` to the `docker compose run` line |
| Every pair `judge_status=call_failed` with HTTP 401 | Stale or rotated key | Verify `ANTHROPIC_API_KEY` against the live Anthropic console; rotate via the project's secret manager |
| Many pairs `judge_status=rate_limited` (HTTP 429) | Anthropic / Ollama Cloud throttling (STAQPRO-224) | Default `JUDGE_RATE_LIMIT_MS=500` is on; raise to `1000` for sustained `judge_rate_limited > 0`, or rerun with `--limit 100`. Distinct from `call_failed` in `status_counts` — `judge_failed` is the union, `judge_rate_limited` is the 429-only subset. |
| A few pairs `judge_status=parse_failed` | Model emitted non-JSON commentary | Inspect `judge_error` + `raw` in the per-pair JSON; if the rate is < 5%, ignore (judge_failed is filtered out of aggregates by design) |
| `judge-only` mode produces all `cosine=null` | Expected — that's what `--judge-only` does | Look at `judge_aggregates_global` instead of `aggregates_global` |
| Output filename has no judge suffix despite passing `--judge=haiku` | Flag was passed before `--` separator | `npm run eval:rag -- --judge=haiku` (note the `--`) |
| `--judge=sonnet` rejected | Only `haiku` and `gpt-oss` are wired | If a third provider is needed, extend `JUDGE_PROVIDERS` in `lib/drafting/judge.ts` and wire the call shape |
| All cosine pre-existing troubleshooting from v0.2.0 | — | See `rag-eval.v0.2.0.md` |

---

## Related decisions + lineage

- **STAQPRO-220 closed STAQPRO-207's open question** ("cosine is too noisy at per-packet scale") by adding the second metric rather than abandoning cosine. Both metrics now ship; Phase-D hypothesis tests will read both and decide on a per-hypothesis basis.
- **Two providers on day one** (haiku + gpt-oss) — Haiku is the default per the cost model + per-call latency; gpt-oss is the no-marginal-cost alternative for runs where the operator wants to avoid hitting the Anthropic budget. Same prompt, same parser; Linus's "don't ship optionality you don't need" was relaxed here because both providers were already wired (`router.ts`) for live drafting and reusing them was a one-day add.
- **Judge sees draft + reply, not inbound** — explicit per the issue Notes. Re-litigation belongs in a new ticket, not a runbook edit.
- **`--judge-only` still drafts** — it skips embed, not generation. The drafted body is what the judge scores; without it, there's nothing to compare against the actual reply. Future "score N independent re-drafts of the same inbound" mode would require a new flag (out of scope here).
