# Persona Pack Spec — Sales Agent

> **v0.1.0 · 2026-06-07 · DRAFT for review**
> Owner: Dustin · Tracks: UMB-114 · Reference implementation of a **Pack** per the [Business PRD](./agentbox-business-prd.v0.1.0.md)
> Purpose: prove the "personas as upsells" model end-to-end with one concrete, buildable Pack.

## TL;DR

**Sales Agent** is a **Persona Pack** that turns a base AgentBOX (with the Email Pack) into a sales-aware assistant: it drafts consultative sales replies in the operator's voice, chases follow-ups, and grounds every draft in the on-box CRM (businesses / contacts / departments — already in the stack via migrations 047–048). It ships as a **gbrain skillpack + a persona seed + a few workflows** — **no new hardware** — installs on Core+, and is sold as a recurring per-box add-on. It's the lightest, fastest-to-attach example of the Pack model.

## 1. What it is / who it's for

A **role overlay** for operators who do B2B sales/biz-dev from their inbox: founders, fractional execs, account managers. It does **not** replace the Email Pack — it **specializes** it: same triage→draft→approve→send loop, but with sales judgment, pipeline awareness, and follow-up discipline layered on.

## 2. Anatomy of the Pack

A Pack is the composition of these artifacts (this is the reusable template for *every* Persona Pack):

| Part | Sales Agent contents | Mechanism |
|---|---|---|
| **Persona seed** | `tone: consultative, confident, concise`; `signoff`; `jargon_allowlist: [ARR, pipeline, churn, POC, MSA, …]`; `business_description` left to operator | A seeded `mailbox.persona` row (`PersonaContext`), overridable in the Tuning tab |
| **Skillpack** | Sales skills: objection handling, discovery-question framing, follow-up cadence, pricing-conversation guardrails, "never overpromise" rules | gbrain skillpack (markdown skills + metadata), `gbrain skillpack install sales-agent` |
| **CRM grounding** | Reads `mailbox.crm.{businesses,contacts,departments,team}` (migrations 047–048) to ground drafts in who the counterparty is | Existing dashboard CRM API + RAG over counterparty history |
| **Workflows** | "Follow-up sweep" (no-reply after N days → draft a nudge); "new-lead intake" (classify + enrich + draft intro) | n8n workflows added to the Email pipeline |
| **Dashboard surface** | A "Sales" view: pipeline-tagged drafts, follow-ups due, per-contact history | Dashboard route/tab gated by entitlement |
| **Guardrails** | No commitments on price/legal/delivery without operator edit; flag deals needing escalation | Skill rules + draft-status gating |

> **Capability vs Persona grade:** Sales Agent is a **Persona Pack** (role overlay on the Email Pack, any tier). If it later grows its own data model / integrations (e.g. a real CRM sync to HubSpot), the CRM piece could graduate to a **Capability Pack** ("CRM Pack") that Sales Agent depends on.

## 3. Install & activation flow

```
operator buys Sales Agent (license key extended with pack:sales-agent)
        │
        ▼
dashboard "Add Pack" → entitlement check (tier ≥ Core, key includes sales-agent)
        │
        ▼
installer steps (idempotent):
  1. gbrain skillpack install sales-agent          # skills into the agent
  2. seed mailbox.persona (sales defaults)          # voice/jargon, operator-overridable
  3. import n8n workflows (Follow-up Sweep, Lead Intake)
  4. enable Sales dashboard view
  5. register pack in the on-box pack manifest (for OTA updates)
        │
        ▼
operator runs 20-sample voice tuning (reuses Email Pack onboarding) → done
```

- **No hardware shipment.** Pure software via the registry.
- **Idempotent + reversible.** `disable` flips entitlement and hides the view; skills/persona can be removed.

## 4. Trust & scoping

- Skillpack installs under gbrain's trust model: agent-facing (MCP) callers are `remote: true` (confined); operator/CLI is trusted. Sales skills get only the tools they declare.
- CRM/email data never leaves the box except via the metered cloud-inference path (cost+20%), and only when a draft is cloud-routed (low-confidence / escalate) — local-first by default.

## 5. Behavior (what the operator sees)

- Inbound sales email → classified (existing pipeline) → **Sales Agent drafts** a reply grounded in the counterparty's CRM record + prior thread RAG, in the operator's tuned voice.
- **Follow-up Sweep** (daily): threads with no reply after N days surface a one-click nudge draft.
- **Guardrails**: any draft touching price/terms/delivery is marked "needs operator confirm" and never auto-sends.
- Operator approves/edits/sends from the Sales view; everything stays in the approval-queue audit trail.

## 6. Commercials (from Business PRD)

- **Grade:** Persona Pack · **Min tier:** Core · **Proposed price:** $39–79/mo (illustrative — validate).
- **Attach thesis:** cheapest, fastest second purchase after Email; reuses the graph Email already built.

## 7. Success metrics

- Attach rate among Email-Pack customers; time-to-attach.
- Sales drafts approved-with-minor-edits vs rewritten (draft quality).
- Follow-ups sent that would otherwise have been missed (the "discipline" value).
- Operator-reported hours saved on sales correspondence.

## 8. Dependencies & open questions

**Depends on:** Email Pack (MailBOX) installed; CRM tables (migrations 047–048, already vendored); gbrain skillpack registry; per-box license/entitlement layer (Business PRD §6 — **not yet built**).

**Open questions**
1. Does Sales Agent require its own CRM data entry, or only enrich what Email captures? (MVP: enrich-only.)
2. Follow-up cadence defaults (N days) — per-category like the urgency engine?
3. Is the entitlement/license layer in scope now, or do early Packs ship "all-on" until billing is built?
4. Where does the line sit between Sales Agent (Persona) and a future CRM Pack (Capability)?

> This spec is the **template**: Customer Success, Legal Brief, and Content Persona Packs follow the same anatomy (§2) and install flow (§3) with different seeds/skills.
