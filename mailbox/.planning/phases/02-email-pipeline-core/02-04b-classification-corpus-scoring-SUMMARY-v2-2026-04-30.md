---
phase: 02-email-pipeline-core
plan: 02-04b
status: gate-ready — D-50 shipped, temperature pinned, sales@ exception in place
date: 2026-04-30
supersedes: 02-04b-classification-corpus-scoring-SUMMARY-v1-2026-04-30.md
---

# 02-04b: Classification Corpus + Scoring — SUMMARY (v2)

This v2 supersedes v1 by closing out **D-50 (operator-identity preclass)**
and the two follow-on fixes the post-D50 scoring surfaced. The corpus
infrastructure described in v1 is unchanged and not repeated here — read
v1 first for the data construction story.

## What shipped since v1

### D-50 — deterministic operator-domain preclass
Commit `15f2865`. New module `dashboard/lib/classification/preclass.ts`:

- `OPERATOR_DOMAINS` env (default: `heronlabsinc.com`) — comma-separated.
- `OPERATOR_ALLOWLIST` env (default: empty) — comma-separated full
  addresses for contractor / external stakeholder coverage. Currently
  unused; reserved for the v3 fix on the 5/9 internal-labeled rows
  whose senders are non-operator domains.
- `OPERATOR_INBOX_EXCEPTIONS` env (default: `sales@heronlabsinc.com`) —
  addresses on the operator domain that legitimately receive prospect
  mail and should fall through to the LLM verdict.
- Override is applied **post-LLM in `normalize.ts`**, not as a pre-LLM
  short-circuit. Keeps the n8n graph linear; the latency cost on
  internal mail is bounded (~3s, well under the 5s MAIL-06 gate). The
  raw LLM output is preserved in `raw_output` for forensics;
  `preclass_applied` and `preclass_source` are exposed for diagnostics.
- n8n classify sub-workflow now plumbs `from_addr` + `to_addr` to
  `/api/internal/classification-normalize`. `to` is unused in v1 logic
  but plumbed for future multi-mailbox / shared-domain allowlisting.

### Sales-inbox exception
Commit `bf8a2c6`. Post-D-50 scoring caught a single regression — a
prospect inquiry sent through `sales@heronlabsinc.com` was being forced
to `internal` and routed local instead of cloud. The
`OPERATOR_INBOX_EXCEPTIONS` list short-circuits the domain rule for
named role addresses. Verified: the row now classifies as `inquiry`
with `preclass_applied: false` and routes to cloud.

### Temperature=0 on the Ollama call
Same commit. n8n `Call Ollama` and `scripts/score-classifier.py` both
pass `options: { temperature: 0 }`. Default temperature 0.8 was
producing 3-4 row-level flips per re-run on the n=82 corpus, which was
masking real prompt/preclass changes under noise. Verified
deterministic: per-row predictions are byte-identical between two runs
(only `latency_ms` differs by < 5ms wall-clock noise).

## Headline metrics (full-body, n=82, temperature=0)

| Metric | Pre-D50 (v1) | Post-D50 + exceptions + temp=0 | Δ |
|---|---:|---:|---:|
| Category accuracy | 61.0% | 51.2% | **−9.8 pt** |
| Route accuracy | 73.2% | 73.2% | **0** |
| internal recall | 0.22 | 0.44 | +22 pt |
| inquiry recall | 0.62 | 0.62 | 0 |
| Latency p95 | 3348 ms | 3434 ms | +86 ms |
| JSON parse ok | 100% | 100% | 0 |

### Why category accuracy dropped while route accuracy held
Operator-domain `follow_up` and `scheduling` rows (jt@, eddie@, nicky@
sending replies on active threads) now get force-labeled `internal`.
Per the D-01/D-02 routing table, all three categories
(`internal/follow_up/scheduling`) route to **local**, so production
routing is unaffected — the −10pt category drop is a label-overlap
artifact, not a production regression. The taxonomy edge between
`internal` (sender-based) and `follow_up` (thread-based) is genuinely
ambiguous when an operator-domain sender continues a thread; the
deterministic rule resolves the ambiguity in favor of `internal`.

### Per-route metrics
| Route | Support | Prec | Recall | F1 |
|---|---:|---:|---:|---:|
| drop | 14 | 0.70 | 0.50 | 0.58 |
| local | 43 | 0.82 | 0.84 | 0.83 |
| cloud | 25 | 0.61 | 0.68 | 0.64 |

Route confusion (rows=true, cols=pred):
```
         drop  local  cloud
drop        7      2      5
local       1     36      6
cloud       2      6     17
```

### Isolated D-50 contribution (8 row flips vs v1 baseline)
Wins (D-50 preclass-attributable):
- 3× `cloud → local`: operator-domain rows the LLM was misrouting
  (`accounting@`, `clinton@` × 2)
- 1× `drop → local`: a `clinton@` scheduling email the LLM had mistaken
  for spam

Losses (D-50 preclass-attributable):
- **0** after the `sales@` exception was added.

LLM-deterministic-but-still-wrong flips (not D-50, surfaced now that
noise is removed):
- 1× `cloud → drop`: `noreply@mail.manus.im` lead-form notification
  (same row identified in v1 — see v1 finding #4).
- 2× `local → cloud`: `bpray9223@gmail.com` and `api-info@metrc.com`
  rows where the LLM bails to `unknown` on ambiguous content. Real
  classifier weakness, separate from D-50.
- 1× `cloud → local`: `liyq@junqibio.com` — LLM directly confuses an
  unknown-class sender for `internal` at high confidence. Spurious.

## MAIL-08 gate verdict

**PASS with documented edges.**

- Route accuracy 73.2% on a stratified n=82 full-body sample, with
  reproducible scoring under temperature=0.
- Local route is the strongest (F1 0.83) — good for the 43-row plurality
  that drives day-to-day operator volume.
- Drop and cloud routes share ~6-8 percentage points of error each;
  both are documented and bounded.
- Category accuracy is not a production-meaningful metric; the
  taxonomy overlap (operator-domain follow_up vs internal) shouldn't
  block the gate.

### Known failure modes carried forward (do not re-litigate)
1. **CRM/lead-form notifications can drop.** `noreply@mail.manus.im` and
   similar form-submission notifiers from no-reply domains can be
   confidently mis-classified as spam_marketing. Mitigation deferred:
   either (a) add a "lead-form notification" detection rule to the
   prompt, (b) restrict the drop route to non-no-reply senders, or
   (c) accept and document for v1.
2. **5/9 of internal-labeled rows have non-`heronlabsinc.com` senders**
   (contractors / external stakeholders). The `OPERATOR_ALLOWLIST` env
   is the surface for this fix; a future task is to capture the
   contractor list during onboarding.
3. **Reorder recall is 0.36** — the LLM frequently over-escalates
   invoice/PO content to `escalate` or `follow_up`. Not addressed in
   D-50; documented in v1.
4. **`unknown` precision is 0.09** — the LLM bails to unknown
   liberally, dragging cloud-route precision down. Same notes as (3).

## Deferred (still open from v1, plus new)

- Pad `escalate` corpus rows beyond 13 (currently 7 in scored set).
- Re-fetch the 38 missing thread bodies (likely from a prior Gmail
  account session).
- Drop `unknown` from ground truth or re-label them — their "correct"
  answer is fundamentally ambiguous.
- **Allowlist work** — populate `OPERATOR_ALLOWLIST` with known
  contractors / external stakeholders, ideally captured during the
  onboarding wizard (02-08).
- **Lead-form-notification rule** — see failure mode (1) above.

## Files of record (additions to v1)

- `dashboard/lib/classification/preclass.ts` — the D-50 module.
- `dashboard/lib/classification/normalize.ts` — accepts `{from, to}`
  context, exposes `preclass_applied` / `preclass_source`.
- `dashboard/app/api/internal/classification-normalize/route.ts` —
  accepts `from` + `to`.
- `n8n/workflows/03-classify-email-sub.json` — Normalize node sends
  `from` + `to`; Call Ollama node pins `temperature: 0`.
- `scripts/score-classifier.py` — forwards `from` + records
  `preclass_applied` / `preclass_source` columns; pins `temperature: 0`.
- `scripts/diff-d50.py` — row-by-row diff helper for two scored CSVs.
- `scripts/heron-labs-corpus.scored-2026-04-30.csv` — final scored run
  with D-50 + exceptions + temperature=0.
- `scripts/heron-labs-corpus.scored-2026-04-30.pre-D50.csv` — preserved
  v1-era baseline for diff comparison (not in repo).

## Commits

- `15f2865` `feat(02-04b/D-50): deterministic operator-domain preclass for internal`
- `bf8a2c6` `fix(02-04b/D-50): inbox exceptions + temperature=0 for reproducibility`
