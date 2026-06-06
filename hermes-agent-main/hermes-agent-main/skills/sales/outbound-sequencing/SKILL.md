---
name: outbound-sequencing
description: "Draft personalized email-first, multi-touch outbound cadences at scale for scored accounts, maintain a human reply queue, and learn from every edit. Sends DISABLED until Gmail consent — drafts only. Sales Persona Job 2.2."
version: 0.1.0
author: AgentBOX
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Sales, Outbound, Sequencing, Cadence, Email, CPG, Sales-Persona, Job-2.2]
prerequisites:
  toolsets: [outbound, enrichment, web]
---

# Outbound Sequencing (Sales Persona — Job 2.2)

Turn the scored account list from Job 2.1 into personalized, multi-touch outbound
DRAFTS at scale, keep a human reply queue, and learn from how the operator edits
each step. The implementation is the native `outbound` toolset
(`tools/outbound_sequencing.py`); this document is the playbook.

## Scope (v1)

- **Email-first.** A 4-touch email cadence (intro -> value -> case_study ->
  breakup) is the default spine. The agent personalizes the copy per step using
  the account's firmographics.
- **LinkedIn is OFF** behind an explicit `allow_linkedin` flag. Even when flagged
  on, LinkedIn steps produce a *manual-task note for a human* — there is no
  browser automation in this module and there never will be.
- **No contact harvesting.** Email-first means the operator supplies the buyer
  email (or it is left blank on the draft); this job does not scrape contact PII.

## Deliverability & guardrails (read this first)

> **NOTHING IS SENT.** Sends are disabled until the operator grants Gmail consent.
> Every step produces an UNSENT draft artifact under
> `$HERMES_HOME/outbound/drafts/` for human approval. Live send-wiring (Gmail
> drafts/API) is a documented TODO.

- **Reputation risk is the whole game.** Cold outbound at volume can burn the
  sending domain's reputation (spam folders, blocklists) and the brand. Because of
  this, Job 2.2 is category **"sends"**: N=20 clean approvals per level and L2
  (autonomous) is gated behind explicit operator authorization. Graduation is
  deliberately slow.
- **No sending without approval — ever at L0/L1.** Do not draft-and-blast. Drafts
  are reviewed individually until trust graduates *and* the operator authorizes
  live sends.
- Keep volume sane, warm the domain, honor unsubscribes, never invent claims.
- **Brand:** always write **"YES!"** (with the exclamation) and the product line
  **"Celebrational Cacao"**. Any health/functional claim is human-gated — do not
  assert benefits in cold copy.

## How to run

1. Read the playbook: `get_outbound_playbook()` (cadence + voice rubric plus
   learned refinements). When running as the outbound cron, the same brief is
   prepended as `## Script Output`.
2. Pull tier-A/B scored accounts from Job 2.1 (`list_scored_accounts(status=
   "approved", tier="A")`) and `enroll_account(account_id, contact_email=...)`.
   Enrollment pulls firmographics from the enrichment store automatically.
3. For each enrolled account, draft each cadence step with
   `draft_sequence_step(account_id, step, body, subject=...)`. Personalize from
   the firmographics; keep copy short and specific. This writes an UNSENT draft
   artifact — it does not send.
4. Summarize the drafted steps and end with the trust header.

**Never send.** This job only produces reviewable draft artifacts and a reply
queue.

## Reply queue

When a prospect replies, log it with `record_reply(account_id, disposition=,
body=)`. This pauses the sequence (status -> `replied`) and parks the reply in the
human queue (`list_replies(status="needs_human")`). Humans own the conversation
from there — the agent does not auto-respond to replies (that is Job 2.3
Speed-to-Lead territory, also draft-and-approve).

## Learning loop

When the operator reviews a drafted step they call `record_sequence_outcome(
account_id, step, human_final=, rejected=, structural_change=, lessons=[...])`. A
clean outcome is *approved with the copy essentially unchanged*; an edit above the
magnitude threshold, a strategy/positioning change (`structural_change=true`), or
a rejection resets the streak. Lessons become learned cadence/voice rules (gbrain
+ the playbook digest) and the Job 2.2 trust counter advances toward autonomy —
slowly, because sends are reputation-critical.

## Output

- `list_sequences(status=)` — enrolled cadences and per-step status.
- `list_replies(status=)` — the human reply queue.
- Draft artifacts under `$HERMES_HOME/outbound/drafts/<account>-step<N>.md`.
