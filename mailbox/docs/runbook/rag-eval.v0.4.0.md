# RAG Eval Runbook v0.4.0

**Status:** v0.4.0 — adds the STAQPRO-222 H5 score-floor sweep and H3 same-thread-suppression isolation procedures on top of the v0.3.0 cosine+judge baseline. Everything in v0.3.0 still applies (cosine + judge modes, CLI flags, output formats, rate limiting); this version only adds two new env knobs and the multi-run sweep harness that drives them.

**Audience:** Operator running offline scoring against the customer-#1 backfilled corpus on the post-H1+H2+H4 baseline (STAQPRO-219 + STAQPRO-221 shipped).

**Tracks:** STAQPRO-222 (H5 + H3 polish). Parent: STAQPRO-207 Phase-D doc `docs/rag-tuning-hypotheses.v0.1.0.md`. Prior baselines: v0.1.0 (cosine bootstrap), v0.2.0 (post-STAQPRO-199 cosine), v0.3.0 (cosine + judge).

**What changed since v0.3.0:**

- New env vars `RAG_MIN_SCORE` (H5) and `RAG_RETRIEVE_EXCLUDE_SAME_THREAD` (H3) recognized by `dashboard/lib/rag/retrieve.ts`.
- New `EmailRetrievalReason` value `'below_score_floor'`. App-side enum only — no DB migration (migration 013 rule).
- New `inbox_thread_id` column on `PairRow` so the harness plumbs `thread_id` through to `retrieveForDraft` (required for H3 to fire under the eval).
- Multi-run shell pattern for the four-threshold H5 sweep + one-shot H3 A/B documented below.

Read v0.3.0 first if you haven't run the eval before; this revision only documents the deltas.

---

## H5 — score-floor sweep

### What it tests

After H1 (self-filter), H2 (outbound+inbound merge), H4 (strip-quoted), and the existing top-K cap, drop refs scoring below `RAG_MIN_SCORE`. The hypothesis is that below ~0.70 cosine, the refs surface borderline-relevant context that hurts more than it helps. Sweep range chosen from the STAQPRO-207 Phase-B inspection — strongest evidence on `19ba502acb1edbf5` (refs at 0.690/0.664, with-RAG cosine 0.633 vs no-RAG 0.751).

### Env knob

`RAG_MIN_SCORE` (default `0.70`). Refs with `score >= RAG_MIN_SCORE` survive the floor. Malformed values fall back to `0.70` (NaN guard).

### Sweep procedure

Run the full cosine+judge eval at four thresholds against the post-H1+H2+H4 corpus. The pre-shipped baseline JSON from STAQPRO-329 is the no-RAG comparator; the four `RAG_MIN_SCORE` runs are with-RAG passes.

```bash
# 1. Make sure post-H1+H2+H4 baseline is live (STAQPRO-219 + STAQPRO-221 shipped):
ssh mailbox1 'cd ~/mailbox && git rev-parse HEAD'
# → must be on a commit that includes commits 597a2cc (219) and bff3c29 (221)

# 2. Pick a judge provider (haiku recommended for cost — gpt-oss for cross-check):
JUDGE=haiku   # or gpt-oss

# 3. Four sweep passes — one per threshold. Each pass: ~3-4 hours wall clock,
#    ~$3 in Haiku API costs at default JUDGE_RATE_LIMIT_MS=500.
for FLOOR in 0.60 0.65 0.70 0.75; do
  ssh mailbox1 "cd ~/mailbox && docker compose --profile migrate run --rm \
    -e POSTGRES_URL=\$POSTGRES_URL \
    -e OLLAMA_BASE_URL=http://ollama:11434 \
    -e QDRANT_URL=http://qdrant:6333 \
    -e ANTHROPIC_API_KEY=\$ANTHROPIC_API_KEY \
    -e RAG_MIN_SCORE=$FLOOR \
    -e RAG_RETRIEVE_EXCLUDE_SAME_THREAD=0 \
    mailbox-migrate sh -c \"npm install --no-audit --no-fund --silent && \
      npm run eval:rag -- --limit all --judge=$JUDGE\""
  echo "completed floor=$FLOOR"
done
```

**Wall-clock budget:** ~14h for the four sweep passes at `--limit all` against the 441-pair corpus. Run overnight; the harness is resumable per-pair (drops only the offending pair on infra failure).

**Cost budget:** ~$12 total at Haiku rates (4 × ~$3). `gpt-oss:120b` via Ollama Cloud is similar but billed differently — check `ollama.com` for current rates.

**`RAG_RETRIEVE_EXCLUDE_SAME_THREAD=0`** during the sweep so H5's effect isn't muddled with H3's. Run the H3 A/B separately (next section).

### Reading the results

Each run writes `dashboard/eval-results/rag-eval-<ISO>-with-rag-judge-<provider>.json` per v0.3.0's filename pattern. Pull all four locally and aggregate:

```bash
mkdir -p /tmp/staqpro-222-sweep
scp 'mailbox1:~/mailbox/dashboard/eval-results/rag-eval-2026-05-*-with-rag-judge-haiku.json' \
    /tmp/staqpro-222-sweep/
```

Build the sweep table — for each threshold compute `mean(cosine_Δ)`, `mean(judge_voice_Δ)`, `mean(judge_score_Δ)`, `refs_per_pair_avg`. Δ = with-RAG-at-floor minus no-RAG baseline. Use `dashboard/scripts/staqpro-329-paired-stats.py` as the starting point — extend it to take a floor argument and emit a TSV row, or inline a sweep script:

```python
# /tmp/staqpro-222-sweep/aggregate.py — pseudocode
import json
from pathlib import Path

baseline = json.loads(Path("rag-eval-<no-rag-baseline>.json").read_text())
baseline_by_pair = {p["inbox_message_id"]: p for p in baseline["per_pair"]}

for floor in [0.60, 0.65, 0.70, 0.75]:
    with_rag = json.loads(Path(f"rag-eval-floor-{floor}.json").read_text())
    deltas_cosine = []
    deltas_judge_score = []
    refs_per_pair = []
    for p in with_rag["per_pair"]:
        base = baseline_by_pair.get(p["inbox_message_id"])
        if base is None or p.get("cosine") is None or base.get("cosine") is None:
            continue
        deltas_cosine.append(p["cosine"] - base["cosine"])
        if p.get("judge_score") and base.get("judge_score"):
            deltas_judge_score.append(p["judge_score"] - base["judge_score"])
        refs_per_pair.append(p["rag_refs_count"])
    print(floor, mean(deltas_cosine), mean(deltas_judge_score), mean(refs_per_pair))
```

**Decision rule:** ship the threshold that maximizes `mean(judge_score_Δ)` AND moves `mean(cosine_Δ)` non-negative. If two thresholds tie, prefer the higher floor (smaller `rag_refs` payload = lower token spend on the cloud path).

Report the table in the STAQPRO-222 closing comment.

---

## H3 — same-thread suppression isolation

### What it tests

After H4 already strips quoted-history on the embed side, same-thread refs may still surface from retrieval scored against the substantive fragment. H3 adds the corresponding retrieval-side filter: `must_not.thread_id: <inbound.thread_id>` on both the inbound and outbound H2 search arms. Whether this helps depends on whether Qwen3 still over-relies on same-thread refs even after H4 has cleaned the input.

### Env knob

`RAG_RETRIEVE_EXCLUDE_SAME_THREAD` (default `'1'` — on). Set to `'0'` to disable.

### A/B procedure

Pick whichever `RAG_MIN_SCORE` won the H5 sweep (default 0.70 if the sweep hasn't completed). Run two passes — one with H3 off, one with H3 on. Compare on the same corpus.

```bash
WINNING_FLOOR=0.70    # replace with H5 sweep verdict

# Pass A — H3 off (post-H1+H2+H4 baseline, possibly H5-floored)
ssh mailbox1 "cd ~/mailbox && docker compose --profile migrate run --rm \
  -e POSTGRES_URL=\$POSTGRES_URL \
  -e OLLAMA_BASE_URL=http://ollama:11434 \
  -e QDRANT_URL=http://qdrant:6333 \
  -e ANTHROPIC_API_KEY=\$ANTHROPIC_API_KEY \
  -e RAG_MIN_SCORE=$WINNING_FLOOR \
  -e RAG_RETRIEVE_EXCLUDE_SAME_THREAD=0 \
  mailbox-migrate sh -c \"npm install --no-audit --no-fund --silent && \
    npm run eval:rag -- --limit all --judge=haiku\""

# Pass B — H3 on
ssh mailbox1 "cd ~/mailbox && docker compose --profile migrate run --rm \
  -e POSTGRES_URL=\$POSTGRES_URL \
  -e OLLAMA_BASE_URL=http://ollama:11434 \
  -e QDRANT_URL=http://qdrant:6333 \
  -e ANTHROPIC_API_KEY=\$ANTHROPIC_API_KEY \
  -e RAG_MIN_SCORE=$WINNING_FLOOR \
  -e RAG_RETRIEVE_EXCLUDE_SAME_THREAD=1 \
  mailbox-migrate sh -c \"npm install --no-audit --no-fund --silent && \
    npm run eval:rag -- --limit all --judge=haiku\""
```

**Cost / wall-clock:** ~$6 / ~7h. Cheaper if Pass A is just the chosen-floor pass from the H5 sweep — Pass A doubles as the comparison baseline; only Pass B is incremental.

### Decision rule

- **Significant positive Δ** on `judge_score` or `cosine` → ship `RAG_RETRIEVE_EXCLUDE_SAME_THREAD=1` (the in-code default) and document in the closing comment.
- **Near-zero Δ (|Δ| < 1pp judge, |Δ| < 0.005 cosine)** → ship the env var, flip the default to `'0'` (off) by editing `excludeSameThread()` in `retrieve.ts`, document "flag exists, off by default because H4 already does the work."
- **Negative Δ** → ship default-off, leave room to revisit if a future customer corpus has different thread-quote behavior.

Document the verdict + numbers in the STAQPRO-222 closing comment.

---

## Combined recommendation

Once H5 floor and H3 default are locked from the eval, update:

1. `dashboard/lib/rag/retrieve.ts` — `minScore()` default and/or `excludeSameThread()` default per the eval verdict.
2. `.env.example` — add a note next to the env var with the eval-derived default.
3. `docs/rag-tuning-hypotheses.v0.1.0.md` — append a "what shipped" addendum (or bump to v0.2.0) with H3+H5 verdicts inline.
4. CLAUDE.md "RAG retrieval (M3.5)" section — mention the two new tunables and link to this runbook.

---

## Privacy reminder

Same as v0.3.0 — judge calls send draft + reply bytes to a cloud provider. Do not run `--judge` against any corpus that hasn't been cleared for cloud egress per the appliance privacy contract.
