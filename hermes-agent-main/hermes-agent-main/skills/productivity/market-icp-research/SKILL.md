---
name: market-icp-research
description: "Define the YES! Celebrational Cacao ICP (DTC consumer, wholesale buyer, corporate gifting), a craft-chocolate/premium-CPG competitive brief, and a seasonal gifting-demand calendar. Feeds enrichment + content. Sales Persona Job 1.1."
version: 0.1.0
author: AgentBOX
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Sales, ICP, Market-Research, Competitive-Intel, CPG, Sales-Persona, Job-1.1]
prerequisites:
  toolsets: [icp_research, web, x_search]
---

# Market & ICP Research (Sales Persona — Job 1.1)

The first link in the YES! sales chain: decide *who* we sell to and *what we're
up against*, so every downstream job scores and writes against the same target.
The implementation is the native `icp_research` toolset
(`tools/icp_research.py`); this document is the playbook.

## Scope (v1)

Three deliverables, all stored as reviewable JSON artifacts (L0 draft-and-approve
— nothing is sent or published):

1. **ICP definitions** — one per segment: `dtc_consumer`, `wholesale_buyer`,
   `corporate_gifting` (plus `other`). Profile, fit signals, disqualifiers,
   channels, pain points.
2. **Competitive brief** — a craft-chocolate / premium-CPG teardown: one record
   per competitor (positioning, price tier, channels, strengths, gaps).
3. **Seasonal demand calendar** — the gifting peaks (Valentine's, Mother's Day,
   holiday, corporate Q4, etc.) that pace outbound and content.

Job 1.1 is **judgment-heavy** — a low graduation candidate. The trust category
defaults to `judgment` (N=5, L2 gated behind authorization).

## How to run

1. Research the market with `web_search` / `x_search`: craft-chocolate brands,
   premium-CPG gifting, specialty-grocery buyers, corporate-gifting platforms,
   gifting seasonality. (Optionally peek the live catalog read-only for own
   pricing/line context — best-effort, GET-only.)
2. Define each ICP segment with `record_icp_segment(segment, title, description,
   fit_signals, disqualifiers, channels, pain_points, sources)`.
3. Record competitors with `record_competitor(name, positioning, price_tier,
   channels, strengths, gaps, sources)`.
4. Set the calendar with `set_demand_calendar(peaks=[{month, occasion, segments,
   intensity, lead_time_weeks}], notes)`.
5. Summarize the ICP + top differentiators + next gifting peak, and end with the
   trust header.

**Never contact anyone and never publish.** This job only produces reviewed
research artifacts.

## Critical cross-wire

Whenever an ICP segment (or competitor) is written, this module re-emits two
plain-text files that are the contract with the rest of the persona:

- `$HERMES_HOME/enrichment/icp_rubric.md` — consumed by Job 2.1's
  `get_icp_rubric()` to score prospect accounts.
- `$HERMES_HOME/content_engine/icp_digest.md` — consumed by the content-brief
  injector (Job 1.3) so blog/content writes against the same ICP and positioning.

Call `export_icp_rubric` (or just re-record a segment) to force a refresh.

## Learning loop

When the operator reviews the research they call `record_research_outcome(
approved=, structural_change=, lessons=[...])`. A clean outcome is *approved with
no structural revision*; if the human materially revises the ICP / brief /
calendar, that is `structural_change=true` and resets the streak. Lessons become
learned research rules (gbrain + the research digest) and the Job 1.1 trust
counter advances toward autonomy.

## Compliance

- Brand is always written **"YES!"** (with the exclamation); product line is
  **"Celebrational Cacao"**.
- Health/functional claims are **human-gated** — never assert them in ICP/brief
  copy.
- LinkedIn / contact-PII research is OFF in v1 (firmographic + market only).

## Schedule

A monthly cron (`install_icp_cron.py`) re-runs the research and refreshes the
cross-wired rubric/digest. The pre-run injector (`inject_icp_brief.py`) prepends
the current ICP, competitors, and demand calendar so each run builds on prior
state rather than starting cold.
