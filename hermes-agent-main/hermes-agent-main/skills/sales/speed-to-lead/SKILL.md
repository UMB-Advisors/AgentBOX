---
name: speed-to-lead
description: "Instantly qualify inbound wholesale inquiries/DMs, draft a reply, and book the call or hand off to a human. Draft-and-approve. Sales Persona Job 2.3."
version: 0.1.0
author: AgentBOX
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Sales, Speed-to-Lead, Inbound, CPG, Sales-Persona, Job-2.3]
prerequisites:
  toolsets: [speed_to_lead, messaging]
---

# Speed-to-Lead (Sales Persona — Job 2.3)

Inbound speed is the whole value: respond to wholesale inquiries and DMs in
minutes. The implementation is the native `speed_to_lead` toolset
(`tools/speed_to_lead.py`); this is the playbook.

## How it runs

A 5-minute backstop cron drains an **inquiry queue**
(`$HERMES_HOME/speed_to_lead/inbox/`). The cron only fires when a lead is
waiting (the injector prints nothing on an empty queue, so the run is skipped).
Inquiries enter the queue via `record_inquiry` — called by an inbound source
adapter (gateway hook / mail poller / manual). The source adapter is not wired
yet; until it is, enqueue with `record_inquiry`.

## Per inquiry

1. Read the rubric: `get_qualification_playbook()`.
2. Qualify the inquiry (business type, volume/intent, channel fit).
3. Draft a reply and choose an action with `draft_lead_response(inquiry_id,
   reply_draft, qualification, recommended_action)`:
   - `book_call` — qualified wholesale intent: propose times, offer to book.
   - `handoff` — large/strategic/ambiguous or pricing negotiation: route to a
     human with a summary.
   - `reply` — simple info request.
   - `disqualify` — out of scope: polite redirect.
4. **Drafts are unsent.** A human approves before anything sends.

## Guardrails

- Never quote wholesale pricing/terms without approval (that is Job 3.1).
- Always "YES!" (with the exclamation) and "Celebrational Cacao". No
  health/functional claims without approval.

## Learning loop

When the operator approves/edits/rejects a draft, `record_lead_outcome(
inquiry_id, ai_draft=, human_final=, rejected=, structural_change=, lessons=[...])`
feeds the Job 2.3 trust counter (category "sends": N=20, L2 only after explicit
authorization — leads are reputation-critical) and captures qualification/voice
lessons to gbrain. A qualification/strategy change is `structural_change=true`.
