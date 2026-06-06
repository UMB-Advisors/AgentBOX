---
name: quote-builder
description: "Draft wholesale quotes, line-sheets, and order forms for YES! Celebrational Cacao from inquiry context and a price book, as UNSENT review artifacts. Pricing is always human-approved. Sales Persona Job 3.1."
version: 0.1.0
author: AgentBOX
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Sales, Quotes, Line-Sheet, Pricing, CPG, Sales-Persona, Job-3.1]
prerequisites:
  toolsets: [quotes]
---

# Quote & Line-Sheet Generation (Sales Persona — Job 3.1)

The first Conversion-stage job: turn a qualified wholesale inquiry into a priced
offer. The implementation is the native `quotes` toolset
(`tools/quote_builder.py`); this document is the playbook.

## Scope (v1)

- Produces **quote**, **line_sheet**, or **order_form** documents as UNSENT
  review-folder artifacts (`$HERMES_HOME/quotes/review/<quote_id>.md`).
- Prices each line against the price book at
  `$HERMES_HOME/quotes/price_book.yaml` (a default is written if absent; a
  `price_book.json` is also accepted). No pyyaml dependency.
- **Does not** push a Shopify `draft_order` — that scope isn't granted, so the
  live wiring is a documented TODO carried on every artifact. Nothing is sent or
  created in Shopify.

## Pricing is always human-approved

This is the hard rule that separates Job 3.1 from the other Sales jobs:

- Every drafted document carries `requires_human_approval=true`.
- Each `floor_price` in the price book is a **hard floor**. Any line whose
  effective unit price is below its floor (or any unknown SKU) is flagged
  `below_floor` / `unknown_sku` and the whole quote is held for human sign-off —
  **regardless of trust level**. The trust counter never overrides the floor.
- The trust counter governs how much review the *wording / structure* of a quote
  needs, not whether a price can ship autonomously.

## How to run

1. Read the price book: `get_price_book()` — products with `wholesale_price`,
   `msrp`, `floor_price`, `moq`, plus `terms` and `volume_breaks`.
2. From the inquiry context, build `line_items` as
   `[{ "sku" or "name", "qty", "unit_price"? }]`. Use the book's wholesale price
   unless the operator/inquiry justifies a deal price in `unit_price` (which is
   floor-checked).
3. Draft it: `draft_quote(account, line_items, doc_type=, inquiry_context=,
   notes=)`. This renders the review-folder markdown artifact and returns its
   path plus any `any_below_floor` / `has_unknown_sku` flags.
4. Summarize the document, surface any below-floor / below-MOQ / below-min-order
   flags for the operator, and end with the trust header.

**Never send the quote or create an order.** This job only produces a reviewed
draft. Brand copy is always `YES!` (with the exclamation) and the product line is
`Celebrational Cacao`. Any health/functional claims stay human-gated.

## Learning loop

When the operator reviews a drafted quote they call `record_quote_outcome(
quote_id, ai_draft=, human_final=, rejected=, structural_change=,
pricing_changed=, lessons=[...])`. A clean outcome is *approved with only trivial
wording edits and no structural or pricing change*. **Any `pricing_changed=true`
is material** and resets the streak — pricing is the judgment-heavy part of the
job. Lessons become learned pricing/positioning rules (gbrain) and the Job 3.1
trust counter advances so quoting graduates toward (gated) autonomy.

## Output

`list_pending_quotes()` returns drafted documents awaiting a verdict; the
rendered artifacts live under `$HERMES_HOME/quotes/review/`.
