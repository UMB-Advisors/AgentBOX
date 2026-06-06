---
name: funnel-builder
description: "Draft YES! Celebrational Cacao funnel assets — landing pages, offers, lead magnets (sampler / gifting guide / subscription teaser), email-capture copy, and A/B variants — as human-reviewable artifacts. Sales Persona Job 1.2."
version: 0.1.0
author: AgentBOX
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Sales, Funnel, Landing-Page, Conversion, CPG, Sales-Persona, Job-1.2]
prerequisites:
  toolsets: [funnel, web]
---

# Funnel & Landing Page Building (Sales Persona — Job 1.2)

Triggered by a **new product, campaign, or promotion**, draft the top-of-funnel
conversion assets for YES! Celebrational Cacao. The implementation is the native
`funnel` toolset (`tools/funnel_builder.py`); this document is the playbook.

This is an **on-demand** job (no cron). Run it when a new product/campaign/promo
lands.

## Scope (v1)

Draft, as **unsent artifacts** for human review:

- **Landing pages** for a campaign/product/promo.
- **Offers** — primary offers and the lead magnets: **sampler offer**, **gifting
  guide**, **subscription teaser**, generic **lead magnet**.
- **Email-capture copy** for the opt-in.
- **A/B variants** of headline / CTA to test.

Page types: `landing`, `sampler_offer`, `gifting_guide`, `subscription_teaser`,
`lead_magnet`.

## Brand rules (non-negotiable in any copy)

- Always write **`YES!`** — with the exclamation.
- The product line is **`Celebrational Cacao`**.
- **Never auto-assert health / functional claims.** Leave any functional benefit
  language flagged for human review — claims are human-gated.

## How to run

1. Read the learned style: `get_funnel_house_style()` (recurring headline /
   offer / CTA / compliance rules from prior edits).
2. (Optional) research the campaign/product with `web_search` for positioning
   and competitive offers.
3. Draft each asset and store it with
   `draft_landing_page(page_type, page_id, body_html, headline, cta, campaign,
   offer, email_capture, ab_variants)`. Each call writes:
   - `$HERMES_HOME/funnel/pages/<page_id>.json` — the durable record;
   - `$HERMES_HOME/funnel/review/<page_id>.md` — readable review wrapper;
   - `$HERMES_HOME/funnel/review/<page_id>.html` — the raw page body;
   - `$HERMES_HOME/funnel/review/<page_id>.offer.json` — the offer sidecar.
4. Summarize the drafted assets, their review paths, and end with the trust
   header.

**Nothing is published.** This job only produces reviewed drafts.

## Live publish (TODO — degraded)

Publishing a Shopify **page** or **discount/price rule** needs the
`write_content` / `write_price_rules` scopes the operator has **not** granted, so
this job NEVER calls live Shopify objects. The `offer.json` + `.html` artifacts
are written exactly so a future publisher can read an approved review folder and
POST the page/discount once scopes land. Until then, live-wiring is a documented
TODO — do not call unscoped Shopify endpoints.

## Learning loop

When the operator reviews a drafted page they call
`record_page_outcome(page_id, ai_draft=, human_final=, rejected=,
structural_change=, lessons=[...])`. A clean outcome is *approved with only
trivial text edits*; an **offer / pricing / positioning** change is
`structural_change=true` and counts as material regardless of text size, which
resets the streak. Lessons become learned funnel rules (gbrain + the house-style
digest) and the **Job 1.2** trust counter advances so funnel drafting graduates
L0 → L1 → L2 (MEDIUM graduation) as the operator stops editing pages.

## Output

`list_pending_pages()` returns the funnel pages awaiting a verdict, each with its
review-folder path — the operator's review queue.
