---
name: sales-enrichment
description: "Find and firmographically score retail/wholesale/gift/corporate-gifting accounts against the YES! ICP into a prioritized, reviewed account list. Sales Persona Job 2.1."
version: 0.1.0
author: AgentBOX
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Sales, Enrichment, Lead-Scoring, CPG, Sales-Persona, Job-2.1]
prerequisites:
  toolsets: [enrichment, web, x_search]
---

# Lead Enrichment & Scoring (Sales Persona — Job 2.1)

Build the scored, prioritized account list that Outbound (2.2/2.3) and
Conversion (3.x) consume. The implementation is the native `enrichment` toolset
(`tools/enrichment_tools.py`); this document is the playbook.

## Scope (v1)

- **Firmographic only** — company-level signals: account type, location, size,
  channel fit, seasonality, stocked brands. **No contact PII** (names, emails,
  titles). Contact-level enrichment waits on the enrichment-provider / LinkedIn
  compliance decision.
- **Account types:** `retail`, `specialty_grocer`, `gift_shop`,
  `corporate_gifting`, `distributor`, `other`.

## How to run

1. Read the rubric: `get_icp_rubric()` (operator/Job-1.1 ICP + learned scoring
   rules). When running as the enrichment cron, the same brief is prepended as
   `## Script Output`.
2. Research candidate accounts with `web_search` / `x_search` — buyer
   directories, specialty-grocery chains, gift-shop networks, corporate-gifting
   marketplaces, regional craft-chocolate stockists.
3. Score each 0-100 against the ICP (>=70 = tier A, 40-69 = B, <40 = C). Be
   explicit in `rationale` about the firmographic signals behind the score.
4. Store with `record_scored_account(name, account_type, fit_score, location,
   website, icp_segment, rationale, firmographics, source)`. Skip accounts
   already on file (check `list_scored_accounts`).
5. Summarize the top tier-A accounts and end with the trust header.

**Never contact anyone.** This job only produces a reviewed list — outreach is
Jobs 2.2 / 2.3.

## Learning loop

When the operator reviews scored accounts they call `record_account_outcome(
account_id, approved=, score_changed=, lessons=[...])`. A clean outcome is
*approved with the score unchanged*; if the human re-scores or re-tiers, that is
material (`score_changed=true`) and resets the streak. Lessons become learned
scoring rules (gbrain + the rubric digest) and the Job 2.1 trust counter advances
so scoring graduates toward autonomy.

## Output

`list_scored_accounts(min_score=, tier=, status=)` returns the prioritized list
(highest fit first) — the spine for outbound sequencing and speed-to-lead.
