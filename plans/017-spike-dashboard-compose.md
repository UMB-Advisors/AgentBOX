# Plan 017: Design spike — dashboard-native compose/send (outbound email without an inbound trigger)

> **Executor instructions**: This is a DESIGN SPIKE, not a build plan. The
> deliverable is a short validation-first design doc — not code. Follow the
> steps, honor STOP conditions, update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- mailbox/dashboard/lib/transitions.ts mailbox/dashboard/lib/n8n.ts mailbox/dashboard/app/api/drafts/`
> On material change, re-read the send path before designing on top of it.

## Status

- **Priority**: P3 — lowest-confidence direction finding; demand unvalidated
- **Effort**: S (spike); build is L
- **Risk**: LOW (documents only); the eventual feature is HIGH-stakes (it
  sends email)
- **Depends on**: plans/003-approve-send-integration-test.md conceptually —
  the send-path contracts it characterizes are the foundation here
- **Category**: direction
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

The dashboard is approve-only: every outbound email starts as a draft
generated from an *inbound* message by the n8n pipeline. The operator cannot
initiate an email ("follow up with X about Y") from the appliance at all —
they context-switch to Gmail, where none of the appliance's persona/signoff/
audit machinery applies. This is a one-directional surface asymmetry the
audit flagged as the adjacent possible: the send webhook, persona seeds,
audit trail, and queue UI all exist; compose is "only" a new entry point into
them. But there is **no recorded customer ask** for it — so this spike leads
with demand validation and an honest go/no-go, not with architecture.

## Current state (verified at planned-at SHA)

- Send path: `POST /api/drafts/[id]/approve` →
  `transitionToApprovedAndSend(id, {...})` (`lib/transitions.ts:39`) — CAS
  status update, then `triggerSendWebhook(id, provider)` (`lib/n8n.ts:74`),
  provider-routed to the n8n send workflows (gmail → mailbox-send, imap →
  mailbox-imap-send; compose env sets
  `N8N_WEBHOOK_URL: http://n8n:5678/webhook/mailbox-send`). Webhook failure
  leaves the row `approved` with `error_message` persisted; the retry route
  recovers (see comments in `app/api/drafts/[id]/approve/route.ts`).
- The drafts data model assumes an inbound anchor: `listDrafts`/`getDraft`
  `innerJoin('inbox_messages as m', 'd.inbox_message_id', 'm.id')`
  (`lib/queries.ts`) — **a compose draft has no inbox message**, which is the
  central schema question.
- Safety machinery tied to the send path: send-attempt lock
  (`clear-send-attempt` route, attestation contract in
  `lib/schemas/drafts.ts:110-116`), gmail cooldown gating, auto-send audit
  rows. Compose must inherit, not bypass, these.
- Persona/profile seeds exist (operator signoff, brand) — grep
  `signoff` in `mailbox/dashboard/lib` for where drafts get their voice.

## Commands you will need

| Purpose | Command |
|---------|---------|
| Confirm the inner-join constraint | `grep -n "inner[Jj]oin('inbox_messages" mailbox/dashboard/lib/queries*.ts` |
| Map the send workflows | `ls mailbox/n8n/ && grep -rln "mailbox-send" mailbox/n8n/ \| head` |
| Find persona seams | `grep -rn "signoff\|persona" mailbox/dashboard/lib --include="*.ts" -l` |

## Scope

**In scope (deliverables)**:
- `docs/compose-send-design.v0.1.0.md` (create): demand-validation section,
  go/no-go recommendation, and — only if leaning go — the minimal
  architecture sketch and phased cut.

**Out of scope**:
- Code, migrations, n8n workflow changes
- Expanding OAuth scopes (note the current Gmail scope set and whether send
  is already granted — the pipeline sends today, so it likely is; verify and
  cite)

## Git workflow

- Branch: `docs/compose-send-design`
- One commit: `docs(dashboard): compose/send design spike with go/no-go`

## Steps

### Step 1: Demand check (write this section first)

Gather the in-repo/issue-tracker evidence for and against: search docs/ PRDs
and the Linear project (via linear-staqs MCP if available — search issues for
"compose", "outbound", "send email") for any customer or operator ask.
Absence of demand is a finding — say it plainly and recommend deferring if
that's where the evidence points. List what signal WOULD justify the build
(e.g., a customer request, operator usage friction notes).

### Step 2 (even if no-go — keep it short): The schema question

Answer the one design question that determines feasibility either way: how a
draft exists without `inbox_message_id`. Options: (a) nullable FK + outbound
metadata columns, (b) a synthetic "compose anchor" row in `inbox_messages`,
(c) a separate `compose_drafts` table joining into the queue UI. Evaluate
against: the inner joins in `lib/queries.ts`, the send-lock/cooldown
machinery, n8n's send-workflow input contract (read the workflow JSON's
expected fields). One page, with a preferred option.

### Step 3 (only if Step 1 leans go): Phased cut

P1: compose → creates a `pending` draft that flows through the EXISTING
approve/send path untouched (compose is just a new draft source — the queue,
locks, audit all apply for free). P2: recipient autocomplete from CRM
contacts (ties to plan 015's reconciled schema). Explicitly exclude: threading
onto existing conversations, scheduling, attachments. Per phase: effort,
files, the new tests required (extend `test/routes/drafts-approve.test.ts`
from plan 003).

## Done criteria

- [ ] `docs/compose-send-design.v0.1.0.md` exists: TL;DR with an explicit
      go/no-go and the evidence for it; schema-question answer with citations;
      phased cut only if go
- [ ] No source code modified (`git status`)
- [ ] `plans/README.md` status row updated (REJECTED is a legitimate outcome
      if Step 1 finds no demand — record it so this isn't re-audited)

## STOP conditions

- The n8n send workflow's input contract can't be determined from the
  workflow JSON in `mailbox/n8n/` — designing a new caller against an opaque
  contract is how double-sends happen; report what's missing.
- You find compose already exists in some form (search
  `grep -rn "compose" mailbox/dashboard/app --include="*.tsx" -l` first).

## Maintenance notes

- If no-go: revisit when a customer asks; the doc's Step 2 answer keeps its
  value (it's the expensive thinking).
- If go: P1's "new draft source, existing send path" principle is the safety
  property a reviewer must defend — any shortcut that bypasses
  `transitionToApprovedAndSend` re-opens the double-send class.
