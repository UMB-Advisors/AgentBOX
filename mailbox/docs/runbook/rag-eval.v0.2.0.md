# RAG Eval Runbook v0.2.0

**Status:** v0.2.0 — Phase 2 re-run after STAQPRO-199 (embed-truncation) shipped. Tracks STAQPRO-207 (parent: STAQPRO-198). Re-runs both passes against the full 441-pair corpus with the long-message tail recovered, and re-locks the customer-#1 baseline.

**Audience:** Operator running the offline cosine-similarity A/B that answers "is the STAQPRO-191 retrieval helping?" against the customer-#1 backfilled corpus (441 inbound,reply pairs, 865 Qdrant points as of 2026-05-02).

**Tracks:** STAQPRO-207 (Phase 2). Parent track: STAQPRO-122 (M3.5 — RAG over Qdrant). Phase-1 baseline lives in v0.1.0 of this runbook.

---

## What this runbook covers

The eval harness scores each historical `(inbound, my_reply)` pair from `mailbox.sent_history` (`source = 'backfill'`) by drafting against the inbound and computing cosine similarity between the draft embedding and Dustin's actual-reply embedding. Run twice — once with RAG retrieval enabled, once with `RAG_DISABLED=1` — and the delta is the answer.

Methodology (locked in the issue):

1. JOIN `sent_history sh ↔ inbox_messages im` on `im.id = sh.inbox_message_id` (the live FK; backfill writes this directly per `lib/onboarding/gmail-history-backfill.ts`). Filter `sh.source = 'backfill'`.
2. For each pair, assemble the same prompt the live drafter would build (`assemblePrompt` + `retrieveForDraft` + `pickEndpoint` + `getPersonaContext` — no synthetic-draft pollution).
3. POST to Ollama `/api/chat` with `qwen3:4b-ctx4k`.
4. Embed both the generated draft and the actual reply via `nomic-embed-text:v1.5`. Cosine similarity is raw dot product (nomic vectors are unit-normalized) with a defensive magnitude divisor.
5. Aggregate global + per-classification-category (mean / median / p25 / p75). Write a JSON report.

**Mode is set by env, not a CLI flag.** Operator runs the same script twice with different `RAG_DISABLED`. Cleaner than baking A/B into the script — see issue spec §C and the "Out of scope" guardrail.

---

## Prereqs

| Item | Why | Where |
|---|---|---|
| Appliance reachable over SSH (`jetson` or `mailbox1`) | Container exec | Direct ethernet `10.42.0.2`, or tailnet `mailbox1.tail377a9a.ts.net` |
| `mailbox-dashboard` container running | Same network for the Postgres / Ollama / Qdrant DNS the harness uses | `docker compose ps mailbox-dashboard` |
| Onboarding backfill complete | The harness reads `sent_history` rows where `source = 'backfill'`. Empty means nothing to score. | `docs/runbook/onboarding-backfill.v0.1.0.md` (run that first if needed) |
| Qdrant `email_messages` collection populated | Required only for the with-RAG pass. The no-rag pass short-circuits before Qdrant. | `curl http://localhost:6333/collections/email_messages \| jq .result.points_count` should be ≥ corpus size minus the empty-body skips |
| `qwen3:4b-ctx4k` model pulled | Drafter — same model the live pipeline uses | `docker compose exec ollama ollama list` |
| `nomic-embed-text:v1.5` model pulled | Embedder for both sides of the cosine | Same `ollama list` |

If any of these are missing, stop and fix first. The harness has no fallback — a missing model surfaces as `draft_failed` / `embed_failed` for every pair.

---

## Running the eval

### Two-pass canonical invocation (mailbox-migrate one-shot pattern)

The prod `mailbox-dashboard` image ships no devDeps so `tsx` is missing — run via `mailbox-migrate` which bind-mounts `./dashboard` and runs `npm install` first. Same shape as the onboarding-backfill runbook.

From the workstation, **with-RAG pass first** (treatment):

```bash
ssh mailbox1 'cd ~/mailbox && docker compose --profile migrate run --rm \
  -e POSTGRES_URL=$POSTGRES_URL \
  -e OLLAMA_BASE_URL=http://ollama:11434 \
  -e QDRANT_URL=http://qdrant:6333 \
  mailbox-migrate sh -c "npm install --no-audit --no-fund --silent && \
    npm run eval:rag -- --limit all"'
```

**No-RAG pass second** (baseline) — same command, with `RAG_DISABLED=1` added:

```bash
ssh mailbox1 'cd ~/mailbox && docker compose --profile migrate run --rm \
  -e POSTGRES_URL=$POSTGRES_URL \
  -e OLLAMA_BASE_URL=http://ollama:11434 \
  -e QDRANT_URL=http://qdrant:6333 \
  -e RAG_DISABLED=1 \
  mailbox-migrate sh -c "npm install --no-audit --no-fund --silent && \
    npm run eval:rag -- --limit all"'
```

> **Why pass env vars with `-e`?** The `mailbox-migrate` service's `environment:` block in `docker-compose.yml` only declares `POSTGRES_URL`. Other vars don't pass through to a one-shot run. (Same gotcha documented in the onboarding-backfill runbook.)

> **`POSTGRES_URL` is read from the host's `.env`** because the docker compose run inherits shell env. If your shell doesn't have it sourced, replace `$POSTGRES_URL` with the literal value.

### Limit flag

- `--limit all` (default) — score every backfilled pair. ~441 pairs on customer #1; expect ~30-60 minutes wall-clock per pass (Qwen3 draft ~3s + 2× nomic embed ~0.5s each per pair, sequential).
- `--limit N` — score the first N pairs ordered by `sent_at ASC`. Use for smoke runs (`--limit 10` is ~1 minute).

### Output

Each pass writes one JSON file:

```
/home/bob/mailbox/dashboard/eval-results/rag-eval-<ISO-timestamp>-<mode>.json
```

…where `<mode>` is `with-rag` or `no-rag`. The directory is gitignored (per-run JSON contains the actual draft + reply bodies — operator-only, never commit).

The harness also prints a summary table to stdout at the end of each run:

```
RAG eval — mode=with-rag model=qwen3:4b-ctx4k
pairs: 441 (requested all)  ok=435 draft_failed=2 embed_failed=4 error=0

Global cosine similarity:
  count=435  mean=0.7234  median=0.7401  p25=0.6512  p75=0.7980  min=0.2104  max=0.9612

Per-category:
  inquiry          count= 219  mean=0.7301  median=0.7450
  reorder          count=  87  mean=0.7892  median=0.7980
  ...
```

---

## Interpreting the numbers

### What you have after both passes

| Pass | mean cosine | what it answers |
|------|-------------|-----------------|
| `with-rag`  | μ_with | "How close is a RAG-augmented draft to the actual reply?" |
| `no-rag`    | μ_without | "How close is a persona-stub-only draft to the actual reply?" |
| **delta = μ_with − μ_without** | — | **"Does retrieval help?"** |

### Decision rule

This is a v1 metric — cosine over a 768-dim embedding is noisy by construction. Treat the delta with appropriate skepticism.

| delta | interpretation | action |
|-------|----------------|--------|
| **delta ≥ +0.03** | RAG is helping. Retrieval is bringing the draft closer to the operator's actual voice/content. | Keep RAG enabled. Re-run quarterly (or after retrieval changes) to track regression. |
| **−0.01 ≤ delta < +0.03** | RAG noise. Retrieval isn't moving the metric meaningfully. | Investigate: are retrieved snippets relevant (`rag_refs_count` per pair, `rag_reason` distribution)? Is the corpus big enough? |
| **delta < −0.01** | RAG is hurting. Persona-stub-only drafts are closer to the actual reply than RAG-augmented ones. | Stop and investigate before customer #2. Likely culprits: counterparty-scoped recall pulling stale context; embedding quality; persona override over-tuning. |

### Per-category split

The `aggregates_by_category` block in the JSON shows where retrieval helps most. Live customer-#1 categories: `inquiry`, `reorder`, `scheduling`, `follow_up`, `internal`, `escalate`, `unknown`. Backfilled rows are mostly `null` (no live classify pass on historical data) — they bucket into `unclassified` in the report.

Expect `reorder` and `scheduling` to benefit most from retrieval (high counterparty-history dependence). Expect `inquiry` and `internal` to benefit least (more generic, less counterparty-anchored).

### Per-pair drift signals

If `status_counts.draft_failed` differs significantly between passes, that's a red flag — the prompt assembly is the same modulo the retrieval injection, so the local model shouldn't be failing more often without RAG. Investigate Ollama logs for that pass.

If `status_counts.embed_failed` is non-trivial, check Ollama's `nomic-embed-text:v1.5` health (model not pulled, or model evicted by Qwen3 LRU pressure on the 8GB unified VRAM).

---

## Customer-#1 baseline

### Phase 2 — re-run after STAQPRO-199 (2026-05-04)

`dustin@heronlabsinc.com` (Heron appliance), STAQPRO-207. Same 441-pair fixture from STAQPRO-193, post embed-truncation fix.

#### Aggregate (per-pass)

| Metric | with-rag | no-rag | delta |
|--------|----------|--------|-------|
| pairs requested | 441 | 441 | — |
| `ok` | **441 (100%)** | **441 (100%)** | — (recovered the 105 long-message embed_failed drops from phase-1) |
| `embed_failed` | **0** | **0** | — |
| `draft_failed` | 0 | 0 | — |
| global mean cosine | 0.7087 | 0.7074 | +0.0013 |
| global median cosine | 0.7102 | 0.7040 | +0.0062 |
| p25 / p75 cosine | 0.6526 / 0.7684 | 0.6525 / 0.7605 | — |
| min / max cosine | 0.4613 / 0.9435 | 0.4752 / 0.9275 | — |
| per-category | all `unclassified` | — | — |
| wall-clock | ~67 min | ~45 min | — (no-RAG faster — skips Qdrant + retrieval embed) |

#### Paired analysis (n=441 — full corpus, no embed_failed exclusions)

| Metric | Value |
|---|---|
| paired n | **441** (vs phase-1 n=289 — recovered the long-message tail) |
| mean(with-RAG) | 0.7087 |
| mean(no-RAG)   | 0.7074 |
| **mean(Δ)** | **+0.0012** (essentially unchanged from phase-1's +0.0011) |
| sd(Δ) | 0.0617 (per-pair noise is ~50× the mean delta) |
| range(Δ) | [−0.2422, +0.2020] |
| Paired t-test (two-sided) | t=+0.42, **p≈0.67** |
| Wilcoxon signed-rank | z=−0.62, **p≈0.54** |
| Sign test | 217 RAG-better / 220 RAG-worse / 4 tied (49.2%) |

**Interpretation:** **Verdict still null.** The STAQPRO-199 long-message tail recovery added 152 pairs (105 embed_failed + 47 partial drops) without moving the verdict — mean(Δ) and all three p-values are essentially unchanged from phase-1. The "long messages are where RAG matters most" hypothesis is rejected by the data. The sign test even tilted slightly *against* RAG (220 worse vs 217 better, vs phase-1's 149/136 tilted toward RAG). Per-pair noise (sd 0.062) remains ~50× the aggregate effect.

#### Phase B — manual outlier inspection (10 threads from phase-1)

The 10 first-run extremes (5 wins +13 to +17pp, 5 losses -15 to -20pp) were re-drafted via the live `assemblePrompt + retrieveForDraft + drafter` pipeline. Two structural patterns surfaced:

1. **Self-retrieval pathology** — every one of the 10 inspected packets shows the top retrieved ref scoring **1.000** (unit cosine). The inbound is matching its own backfilled twin in Qdrant, wasting one of the top-k slots.
2. **All inbound, never outbound** — 100% of retrieved refs are `direction=inbound`. Operator outbound replies are never surfaced, so retrieval cannot prime operator voice.

**5 of 10 outliers FLIPPED sign on re-run** with identical inputs. Qwen3 sampling noise produces draft-vs-reply cosine swings of ±0.10–0.20 — comparable to or larger than any plausible RAG effect. This implies (a) the per-packet "outlier" set itself is unstable, and (b) cosine-vs-reply is metric-limited at per-packet scale.

Phase D (retrieval-tuning hypotheses) lives in `docs/rag-tuning-hypotheses.v0.1.0.md`.

#### Phase 1 → Phase 2 comparison

| Metric | Phase 1 (n=289) | Phase 2 (n=441) | Δ |
|---|---|---|---|
| mean(with-RAG) | 0.7112 | 0.7087 | -0.0025 |
| mean(no-RAG) | 0.7101 | 0.7074 | -0.0027 |
| mean(Δ) | +0.0011 | +0.0012 | +0.0001 |
| sd(Δ) | 0.0579 | 0.0617 | +0.0038 |
| t-test p | 0.75 | 0.67 | — |
| Wilcoxon p | 0.41 | 0.54 | — |
| sign test (better/worse/tied) | 149/136/4 (52.3%) | 217/220/4 (49.2%) | — |

**JSON artifacts (Phase 2):** `dashboard/eval-results/rag-eval-2026-05-04T06-29-57-795Z-with-rag.json`, `rag-eval-2026-05-04T07-15-22-415Z-no-rag.json`, `staqpro-207-inspection-2026-05-04T07-18-01-583Z.json` (10-packet outlier dump). Operator local — gitignored.

**Paired-stats script (re-implemented):** Inline at `dashboard/scripts/staqpro-207-paired-stats.py` — supersedes the phase-1 `/tmp/eval-pull/paired-stats.py` reference (which was scratch space, not persisted). Pure stdlib; indexes pairs by `sent_history_id` (unique per row, not by `inbox_message_id` which can repeat).

### Phase 1 — first run (2026-05-02)

Phase-1 numbers preserved here for completeness. Phase 2's recovered tail did not change the verdict, so the phase-1 baseline is still the operator's mental model of "what RAG is doing on customer #1."

#### Aggregate (per-pass, ok subset)

| Metric | with-rag | no-rag | delta |
|--------|----------|--------|-------|
| pairs requested | 441 | 441 | — |
| `ok` | 336 (76%) | 336 (76%) | — |
| `embed_failed` | 105 | 105 | — (same long-message tail in both — pre-STAQPRO-199) |
| `draft_failed` | 0 | 0 | — |
| global mean cosine | 0.7102 | 0.7122 | −0.0020 |
| global median cosine | 0.7098 | 0.7130 | −0.0032 |
| p25 / p75 cosine | 0.6514 / 0.7750 | 0.6557 / 0.7732 | — |
| min / max cosine | 0.4613 / 0.9435 | 0.4842 / 0.9209 | — |
| wall-clock | ~22 min | ~22 min | — |

#### Paired analysis (n=289 — pairs OK in **both** passes)

| Metric | Value |
|---|---|
| paired n | 289 |
| mean(with-RAG) | 0.7112 |
| mean(no-RAG) | 0.7101 |
| **mean(Δ)** | **+0.0011** (RAG marginally higher) |
| sd(Δ) | 0.0579 |
| range(Δ) | [−0.2012, +0.1725] |
| Paired t-test (two-sided) | t=0.32, p≈0.75 |
| Wilcoxon signed-rank | z=−0.83, p≈0.41 |
| Sign test | 149 RAG-better / 136 RAG-worse / 4 tied (52.3%) |

**Phase-1 JSON artifacts:** `dashboard/eval-results/rag-eval-2026-05-02T07-22-49-651Z-with-rag.json`, `rag-eval-2026-05-02T08-07-48-168Z-no-rag.json`.

---

## Idempotency + safety

- **No DB writes.** The harness is read-only against Postgres. Unlike the live `/api/internal/draft-prompt` route, it does NOT update `drafts.rag_context_refs` or `drafts.rag_retrieval_reason` — there's no `drafts` row to update for backfilled inbounds, and inserting synthetic ones would pollute the live queue.
- **No Qdrant writes.** The harness only queries Qdrant (search), never upserts. Re-run as often as needed.
- **Re-run safe.** Each run produces a fresh JSON file timestamped with `generated_at` — old runs aren't overwritten. Operator can compare across runs by file.
- **Operator privacy.** JSON contains the actual draft + reply bodies. Stay on the appliance — never `scp` to a non-operator-owned machine. The `dashboard/eval-results/` directory is gitignored.

---

## Out of scope (don't let this grow)

Per the issue spec:

- **LLM-judge scoring.** Cosine is the v1 metric; revisit if cosine proves too noisy after a few runs.
- **Live operator-edit-rate metric.** STAQPRO-192's original methodology, deliberately abandoned (sample size of 1 over 7 days couldn't move the needle).
- **Cloud-route eval.** Cloud route is RAG-gated by default (`RAG_CLOUD_ROUTE_ENABLED=0`) — eval covers LOCAL route only. Backfill rows default-route to `inquiry` which is local; no cloud-route smoke is run.
- **A/B mode flag on the script.** Two `RAG_DISABLED` invocations is the contract. Don't add `--with-rag` / `--no-rag` flags.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `POSTGRES_URL not set` | Env var didn't pass through to the one-shot | Pass it explicitly via `-e POSTGRES_URL=$POSTGRES_URL` |
| Every pair `draft_failed` with HTTP 404 | `qwen3:4b-ctx4k` model not pulled | `docker compose exec ollama ollama list` then `ollama pull qwen3:4b` + create the 4k-ctx Modelfile per DR-18 if missing |
| Every pair `embed_failed` | `nomic-embed-text:v1.5` not pulled, or evicted by VRAM pressure | `docker compose exec ollama ollama list`, then `ollama pull nomic-embed-text:v1.5`. If VRAM-tight, run only the no-rag pass first to avoid Qdrant + embed coexistence stress, or restart `ollama` between passes |
| `with-rag` pass shows mostly `rag_reason='no_hits'` | Qdrant collection empty or corpus didn't backfill | `curl http://localhost:6333/collections/email_messages \| jq .result.points_count` — should be ~865 on customer #1. If 0, run `npm run rag:backfill` first |
| `with-rag` pass shows `rag_reason='qdrant_unavailable'` | Qdrant container down or unreachable from `mailbox-migrate` | `docker compose ps qdrant`, restart if exited |
| `no-rag` pass shows non-`disabled` reasons | `RAG_DISABLED=1` didn't propagate | Verify the env var is on the `docker compose run` line, not inside the inner shell command |
| Wall-clock much longer than expected | Other pipeline traffic competing for Ollama | Pause the schedule trigger in n8n editor for the duration of the run, or restrict to `--limit 50` for a quick read |

---

## Related decisions + lineage

- **Pivot from edit-rate-delta** (the original STAQPRO-192 methodology): unworkable at customer #1 scale (single sent draft over 7 days → `sample_size=1`, `edit_rate=0`). The cosine A/B is offline, replayable, and produces useful numbers from day one.
- **Same-script-two-envs** vs **--no-rag flag**: the env-var contract is invariant — if a future eval mode flips behavior at the retrieval layer (e.g., a different Qdrant collection), the same `RAG_*` env pattern keeps the script signature stable.
- **Read `inbox_messages.body` directly, not `sent_history.body_text`**: the backfill orchestrator copies inbound body INTO `sent_history.body_text` for live-pipeline-shape consistency, but for eval the canonical inbound source is `inbox_messages.body`. Keeps the harness's intent legible.
- **Drafter call shape** (`/api/chat`, not `/api/generate`): matches the live MailBOX-Draft workflow exactly. The issue spec said `/api/generate` but the live n8n payload + `lib/drafting/router.ts` use `/api/chat`. Same model, same prompt, same response — `/api/chat` is the truth.
