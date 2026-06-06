---
name: paid-ads
description: "Turn a pasted/CSV paid-ad performance snapshot into a report, budget-pacing recommendations, and creative-variant drafts for YES! Celebrational Cacao. Reporting + advisory only (Track A). Sales Persona Job 1.4."
version: 0.1.0
author: AgentBOX
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Sales, Paid-Ads, Reporting, CPG, Sales-Persona, Job-1.4]
prerequisites:
  toolsets: [paid_ads]
---

# Paid Ad Management — Track A (Sales Persona — Job 1.4)

**Heavily degraded by design.** The agent box has **no Meta / TikTok Marketing
API access**, so this job is **Track A only**: report on a performance snapshot
the operator pastes/exports, recommend budget pacing, and draft creative
variants. The implementation is the native `paid_ads` toolset
(`tools/paid_ads.py`); this document is the playbook.

## Scope (v1)

- **Track A — reporting + advisory + drafts (this job).**
  - `record_ad_performance` — parse a pasted CSV/TSV snapshot → per-line KPIs
    (CTR/CPC/CPA/ROAS/CVR) + budget-pacing recommendations + an UNSENT Markdown
    report in the review folder.
  - `get_ad_recommendations` — read a snapshot's advisory recommendations and the
    learned ad-playbook, or list stored snapshots.
  - `draft_ad_creative` — write creative-variant DRAFTS to the review folder for
    the operator to run manually.
  - `record_ad_outcome` — the human verdict on a report; feeds the Job 1.4 trust
    counter.
- **Track B — live campaigns / budget changes / spend. DEFERRED.** Blocked
  behind Meta + TikTok app review. **There are no spend-mutation tools in this
  module and none may ever be loaded into a cron.** When Track B is eventually
  built it lives in a separate, explicitly human-gated module and must **never**
  run autonomously. This is a deliberate, documented TODO — do not call any
  unscoped ad-platform endpoint.

## How to run (Track A)

1. The operator exports a performance snapshot from Ads Manager (campaign / ad-set
   / ad rows) as CSV or pastes the table. First column = the line label;
   recognized metric columns: `spend`, `impressions`, `clicks`, `conversions`,
   `revenue` (common aliases like "Amount spent" / "Link clicks" / "Purchases"
   are mapped automatically).
2. Call `record_ad_performance(snapshot_id, raw_snapshot, platform, period,
   target_roas?, target_cpa?)`. This writes the report to the review folder and
   returns totals, blended KPIs, and the advisory recommendations.
3. Read `get_ad_recommendations(snapshot_id)` for the pacing calls
   (`pause` / `scale_up` / `scale_down` / `hold`) and the rationale. **Apply any
   action manually in Ads Manager** — the box changes nothing.
4. Draft fresh creative with `draft_ad_creative(creative_id, variants, platform,
   angle)`. Brand voice is always **"YES!"**, product line **"Celebrational
   Cacao"**; any health/functional claim is human-gated.
5. End your summary with the trust header.

## Recommendation logic (advisory)

Per line, vs the blended (or operator-supplied) benchmark:

| Signal | Action |
|---|---|
| Spend > 0 and 0 conversions | `pause` |
| ROAS ≥ 1.2× benchmark (with conversions) | `scale_up` |
| CPA > 1.5× benchmark, or ROAS < 0.5× benchmark | `scale_down` |
| Otherwise | `hold` |

These are suggestions only. Nothing is executed; the box has no spend access.

## Learning loop (reporting-only, MEDIUM graduation)

When the operator reviews a report they call `record_ad_outcome(snapshot_id,
ai_report=, human_report=, rejected=, structural_change=, lessons=[...])`. Clean =
approved with no material edits and no `structural_change` (a changed pacing call
or metric interpretation is structural). Lessons become learned rules (gbrain +
the `ad-playbook.md` digest) and the **Job 1.4** trust counter advances.

Graduation is **MEDIUM and reporting-only** — the counter is seeded to a
content-style threshold (N=10, no L2-auth gate) because nothing this job emits
touches money. Even at L2 the job only produces reports/recommendations/drafts;
it can **never** autonomously change spend (that is Track B, deferred).

## Output

- `paid_ads/review/<snapshot>-report.md` — the performance report.
- `paid_ads/review/creative-<id>-vN.md` — creative-variant drafts.
- `paid_ads/ad-playbook.md` — the learned recurring rules.
