---
name: pipeline-forecasting
description: "Maintain a lightweight YES! deal pipeline and produce a stage-weighted weekly forecast plus a stalled-deal list. Reporting is read-only/autonomous; deal mutations are trust-gated. Sales Persona Job 3.2."
version: 0.1.0
author: AgentBOX
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Sales, Pipeline, Forecasting, CPG, Sales-Persona, Job-3.2]
prerequisites:
  toolsets: [pipeline]
---

# Pipeline & Forecasting (Sales Persona — Job 3.2)

The conversion-stage readout for YES! Celebrational Cacao wholesale and
corporate-gifting opportunities. Maintain deals, surface stalled ones, and
produce a stage-weighted weekly forecast. The implementation is the native
`pipeline` toolset (`tools/pipeline.py`); this document is the playbook.

## Scope (v1)

- **Store:** JSON deal records under `$HERMES_HOME/pipeline/deals/<id>.json`
  (kanban / JSON per build-plan OQ2 — explicitly NOT Postgres).
- **Stages and forecast probabilities:** `lead` 10%, `qualified` 25%,
  `sample_sent` 40%, `proposal` 60%, `negotiation` 80%, `closed_won` 100%,
  `closed_lost` 0%. Only the non-closed stages count as open pipeline.

## Two trust postures

- **Reporting is read-only and autonomous.** `list_deals`, `stalled_deals`, and
  `forecast` never mutate state and run on the weekly cron without a human in the
  loop.
- **Deal mutations are trust-gated.** `upsert_deal` creates/updates a deal and
  re-enters review (`review_status=new`). The operator's verdict drives the Job
  3.2 trust counter via `record_pipeline_outcome`.

## How to run

1. **Update deals.** For each new or changed opportunity call
   `upsert_deal(account, stage, amount, owner, expected_close, last_touch,
   notes)`. Deals are keyed by `deal_id` (defaults to a slug of the account), so
   re-calling with the same account updates in place; only fields you pass change.
2. **Surface risk.** `stalled_deals(days=14)` returns open deals with no touch in
   the window (deals with no recorded `last_touch` are treated as stalled).
3. **Forecast.** `forecast()` returns raw and weighted pipeline totals plus
   per-week (by `expected_close`) and per-stage breakdowns. Weighted =
   `amount * stage_probability`.
4. End reports with the trust header.

**Never contact anyone and never quote pricing here.** Outreach is Jobs 2.2/2.3;
quotes/line-sheets are Job 3.1. This job only reports on and maintains pipeline
state.

## Learning loop

When the operator reviews deal mutations they call `record_pipeline_outcome(
deal_id, approved=, corrected=, lessons=[...])`. A clean outcome is *approved with
no correction*; if the human had to fix stage/amount/close/account, that is
material (`corrected=true`) and resets the streak. Lessons become learned
pipeline-hygiene rules (gbrain + the pipeline digest) and the Job 3.2 trust
counter advances so the pipeline graduates toward autonomy.

## Weekly cron

`install_pipeline_cron.py` deploys `inject_forecast.py` to `$HERMES_HOME/scripts/`
and creates a Monday 07:30 job. The injector dumps the current weighted forecast
and the stalled-deal list (read-only) so the run starts from the live numbers.

## Output

`forecast()` is the headline number for the dashboard pipeline tile;
`stalled_deals()` is the follow-up worklist; `list_deals(open_only=true)` is the
full open book, highest weighted value first.
