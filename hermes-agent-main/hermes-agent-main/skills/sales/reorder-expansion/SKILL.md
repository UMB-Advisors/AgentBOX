---
name: reorder-expansion
description: "Detect reorder timing for wholesale accounts and surface upsell/expansion signals, then draft (never send) reorder outreach prompts for human review. Sales Persona Job 3.3."
version: 0.1.0
author: AgentBOX
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Sales, Reorder, Expansion, Wholesale, CPG, Sales-Persona, Job-3.3]
prerequisites:
  toolsets: [reorder]
---

# Reorder & Expansion Triggers (Sales Persona — Job 3.3)

Keep wholesale accounts reordering YES! Celebrational Cacao on time and surface
expansion opportunities — by watching each account's order cadence and drafting
(never sending) a reorder/expansion nudge when an account goes overdue. The
implementation is the native `reorder` toolset (`tools/reorder.py`); this
document is the playbook.

## Scope (v1)

- **Order-history source is DEGRADED.** Live Shopify `read_orders` is not yet
  scoped, so this job ingests order history from operator-dropped CSV/JSON stub
  files under `$HERMES_HOME/reorder/orders/`. Live Shopify order pull is a
  documented TODO in `ingest_order_history`.
- **Draft only (L0).** Everything produced is an UNSENT review artifact under
  `$HERMES_HOME/reorder/prompts/`. Outreach is human-approved before sending.
- **No health/functional claims** in any drafted copy without human approval.

## How to run

1. `ingest_order_history()` — pull the operator's order-history stubs into
   normalized per-account histories. (Drop CSVs with `account,date[,amount]`
   columns, or JSON, into `$HERMES_HOME/reorder/orders/`.)
2. `detect_reorders()` — run the cadence model: average interval between orders,
   days since last order, and an `overdue` flag (past `avg_interval * 1.25`).
   Returns the overdue set, most overdue first.
3. For each overdue account, `draft_reorder_prompt(account_id, expansion_signals,
   draft_message, note)` — write a YES! Celebrational Cacao reorder nudge as an
   UNSENT review file. Note any expansion signal (seasonal SKU fit, growing order
   size, new location) but keep functional/health claims out unless human-gated.
4. End with the trust header. **Never contact anyone** — this job only drafts.

When running as the weekly cron, the injector prepends the current due-reorder
set as `## Script Output`; if nothing is due it prints nothing and the run is
skipped.

## Learning loop

When the operator reviews a drafted prompt they call `record_reorder_outcome(
account_id, human_final=, rejected=, structural_change=, lessons=[...])`. A clean
outcome is *approved with a near-identical message and no structural change*; an
edit, rejection, or strategy change is material and resets the streak. Lessons
become learned reorder/expansion rules (gbrain) and the Job 3.3 trust counter
advances so the job graduates L0 -> L1 -> L2. Graduation L0->L1 is fast (this is
`content`-category in the trust config — low individual risk, high cadence).

## Output

`list_reorder_prompts(status=)` returns the drafted prompts (most overdue first)
— the reorder/expansion outreach queue for human approval.
