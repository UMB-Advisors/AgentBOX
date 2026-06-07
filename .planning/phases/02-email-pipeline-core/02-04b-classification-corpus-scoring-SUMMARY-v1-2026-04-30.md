---
phase: 02-email-pipeline-core
plan: 02-04b
status: partial — scoring infrastructure complete, gate verdict pending prompt iteration
date: 2026-04-30
---

# 02-04b: Classification Corpus + Scoring — SUMMARY

## What shipped

### Labeled corpus (635 rows, 8 categories)
Five CSV batches under `scripts/`, combined via `/tmp/combine-corpus.py` into
`scripts/heron-labs-corpus.sample.json` (last-wins override semantics so
batch 5's manual review supersedes earlier auto-labels):

| File | Source | Rows | Notes |
|---|---|---:|---|
| `heron-labs-corpus.draft-2026-04-29.csv` | 20 (after relabel) | live `mailbox.inbox_messages` | full bodies in DB |
| `heron-labs-corpus-batch2.draft-2026-04-29.csv` | 122 | Gmail before:2026-04-27 | manually labeled |
| `heron-labs-corpus-batch3.draft-2026-04-30.csv` | 194 | Gmail before:2026-04-10 | auto-labeled (`/tmp/label-batch3.py`) |
| `heron-labs-corpus-batch4.draft-2026-04-30.csv` | 284 | Gmail before:2026-03-23 | auto-labeled (`/tmp/label-batch4.py`) with retroactive overrides |
| `heron-labs-corpus-batch5.draft-2026-04-30.csv` | 23 | targeted padding | escalate + reorder (rare classes) |

**Distribution:** spam_marketing 269 (42%), internal 184 (29%), follow_up 63 (10%),
inquiry 50 (8%), unknown 20 (3%), reorder 19 (3%), scheduling 17 (3%), escalate 13 (2%).

### Scoring script (`scripts/score-classifier.py`)
Designed to run on the Jetson (services on localhost). Reads
`heron-labs-corpus.sample.json` + optional `corpus-bodies.json`, fetches DB bodies
via `docker exec mailbox-postgres-1 psql ... -At` (one round-trip), calls the
production classification chain (`/api/internal/classification-prompt` → Ollama →
`/api/internal/classification-normalize`), records per-row prediction + latency,
emits per-category metrics + confusion matrix + **route-based metrics** (D-01/D-02
mirror).

Flags:
- `--source db|gmail|all` — filter corpus rows
- `--bodies-only` — restrict to rows with full bodies (skips snippet-only fallback)
- `--limit N` — quick smoke test

### Body cache (`scripts/corpus-bodies.json`)
62 thread bodies fetched via Gmail MCP `get_thread` for a stratified sample
(seed=42, all rare classes + 12 per bulk class = 100 IDs). Picks the **latest**
message body per thread to match production ingestion. 38/100 IDs returned
"not found" — likely from a previous Gmail account session and silently dropped.

## Headline results (full-body, n=82)

```
Category accuracy: 61.0%  (50/82)
Route accuracy:    73.2%  (60/82)
JSON parse ok:     100%
Latency p95:       3348ms  (well under 5s MAIL-06 gate)
```

### Per-category metrics
| Category | Support | Prec | Recall | F1 |
|---|---:|---:|---:|---:|
| inquiry | 13 | 0.80 | 0.62 | 0.70 |
| reorder | 11 | 1.00 | 0.45 | 0.62 |
| scheduling | 14 | 0.62 | 0.93 | 0.74 |
| follow_up | 9 | 0.54 | 0.78 | 0.64 |
| internal | 9 | 1.00 | 0.22 | 0.36 |
| spam_marketing | 14 | 0.70 | 0.50 | 0.58 |
| escalate | 7 | 0.60 | 0.86 | 0.71 |
| unknown | 5 | 0.18 | 0.40 | 0.25 |

### Per-route metrics
| Route | Support | Prec | Recall | F1 |
|---|---:|---:|---:|---:|
| drop | 14 | 0.70 | 0.50 | 0.58 |
| local | 43 | 0.83 | 0.79 | 0.81 |
| cloud | 25 | 0.61 | 0.76 | 0.68 |

Route confusion:
```
         drop  local  cloud
drop        7      2      5
local       2     34      7
cloud       1      5     19
```

## Findings

**1. Snippets are not a valid scoring proxy.** Initial run on snippet-as-body
(`--source all`, n=635) hit 35% category / not measured route. Re-running on
full bodies (n=82) jumped to 61%/73%. The model correctly bails to `unknown`
when input signal is too thin, so snippet evaluation is misleading. Full-body
scoring is the honest baseline.

**2. The `internal` category is sender-based but the prompt has no operator-identity context.**
Internal recall is 0.22 — the model can't tell which sender domains belong to the
operator. Attempted fix (prompt-level operator domain injection, commit d7cca9d
since reverted in cf1a78c) gave mixed results: internal +2pts but reorder
collapsed (0.36 → 0.09) because the new "human judgment" emphasis made the model
over-escalate invoice content. Net no overall accuracy change. The fix needs a
different approach — likely deterministic preclass on `from_addr` outside the
LLM, plus passing `to_addr` to the prompt.

**3. Categories overlap operationally.** "Re: Invoice" can be `reorder` (active
order/payment) or `escalate` (customer complaint about the invoice) depending on
tone. Route-based scoring largely absorbs this — both stay `cloud` if classified
as inquiry/escalate/unknown vs `local` if reorder. The 73% route accuracy is the
production-meaningful number, not the 61% category accuracy.

**4. Two production-sensitive failure modes:**
- 5/14 spam → cloud (drop→cloud): model under-confidence on spam → falls back
  to cloud. Wastes API budget.
- 2/14 spam → local (drop→local): false negatives on spam reach the draft queue.
  Operational issue; small.
- 7/43 local → cloud: cost+latency penalty but no functional break.
- 1/25 cloud → drop: dangerous — escalate-class email silently dropped. Need to
  inspect this row before relying on the 73% route number for a hard gate.

## Deferred to next session

- **D-50: Operator-identity injection (still open).** Try architectural option
  before another prompt-tweak: pre-classify based on from-domain in normalize.ts
  or n8n, fall through to LLM only when the deterministic check is ambiguous.
  Will require also passing `to_addr` from the n8n workflow.
- **The 1 cloud→drop case.** Inspect which corpus row this is (highest-severity
  routing failure on a small sample = high false-confidence risk).
- **Pad `escalate`** beyond 13 corpus rows (currently 7 in scored set after
  Gmail fetch losses). Targeted searches for legal/refund/complaint terms.
- **Re-fetch the 38 missing thread bodies** by running search_threads on the
  current account and verifying ID format. Possible: those IDs came from
  a different Gmail session.
- **Drop `unknown` from ground truth** or re-label them. Their "correct" answer
  is fundamentally ambiguous; including them lowers all metrics without signal.
- **MAIL-08 gate verdict** is not yet final. Current state suggests the
  classifier is *plausible* but the `internal` recall and the cloud→drop edge
  case need fixing before the gate can pass with confidence.

## Files of record

- `scripts/heron-labs-corpus.sample.json` — combined corpus (635 rows)
- `scripts/heron-labs-corpus*.draft-2026-04-{29,30}.csv` — source batches
- `scripts/corpus-bodies.json` — 62 fetched gmail bodies
- `scripts/heron-labs-corpus.scored-2026-04-30.csv` — last scoring run output
- `scripts/score-classifier.py` — scoring engine (runs on Jetson)
- `/tmp/combine-corpus.py` — corpus merge helper (last-wins override)
- `/tmp/stratified-sample.py` — stratified sample picker (seed=42)
- `dashboard/lib/classification/prompt.ts` — current prompt (reverted to pre-D-50 state)
