# Compose/Send Design Spike — Dashboard-Native Outbound Email

**Version:** v0.1.0  
**Date:** 2026-06-11  
**Plan:** 017  
**Status:** SPIKE COMPLETE

---

## TL;DR

**VERDICT: NO-GO (defer)**

Zero recorded customer or operator demand was found in-repo. The feature is technically feasible in principle but carries a hard blocker that makes the plan's framing incorrect: both `MailBOX-Send` and `MailBOX-Imap-Send` are hardwired as **reply** operations, not new-message sends. A compose capability would require new n8n workflows before any dashboard work. With no validated demand to justify that investment, deferral is the correct call.

---

## 1. Demand Validation

### Search methodology

Searched across:

- `docs/` — all PRDs, addendums, STATE files, ROADMAP, product specs
- `mailbox/dashboard/` — code comments, TODO markers, component code, test fixtures

Search terms: `compose`, `outbound`, `follow.up` (as a feature request distinct from the classification category), `send email`, `initiat`, `cold email`, `follow-up discipline`.

### Findings

**No recorded customer or operator ask for compose was found.**

| Source | Hit | Classification |
|--------|-----|----------------|
| `docs/dashboard-simplification-prd.v0.1.0.md:87` | "MailBOX compose" | Docker Compose, not email compose |
| `docs/unified-inbox-prd.v0.1.0.md:88` | "outbound for social" | Approve→adapter-send for social channels; not email compose |
| `docs/product/persona-pack-sales-agent.v0.1.0.md` | "chases follow-ups", "follow-up discipline" | Describes chasing follow-ups on **inbound** threads; explicitly operates within the existing triage→draft→approve→send loop |
| `mailbox/dashboard/components/DraftCard.tsx:21` | "outbound disposition (sent view)" | UI display label |
| `mailbox/dashboard/components/SourcesUsedPanel.tsx:31,225` | `direction: 'inbound' \| 'outbound'` | Type definition for sources panel |
| `mailbox/dashboard/test/classification/operator-self-loop.test.ts:6` | "operator's own outbound email looping back" | Classification guard, not a feature request |
| `docs/ROADMAP-v1.0.0.md:60` | "no outbound net during embed" | Refers to embedding network isolation |
| `mailbox/dashboard/components/ChatClient.tsx:321` | `{/* Composer */}` | Hermes chat input box, not email |

**Note:** Linear is unsearched in this spike (tools unavailable at runtime). Searching the MBOX backlog for "compose" is the recommended next step before revisiting this verdict.

### Absence is the finding

No PRD, operator note, TODO, backlog reference, or code comment expresses this need. The Sales Agent persona spec (`docs/product/persona-pack-sales-agent.v0.1.0.md`) is the closest adjacent document and explicitly scopes to the inbound loop — it does not extend to compose.

### What signal would justify building this

1. A Linear issue or operator conversation confirming someone tried to initiate a cold or follow-up email from the dashboard and was blocked by the lack of compose.
2. Usage evidence that a meaningful fraction of sent emails were not inbound replies (requires analysis of `sent_history`).
3. An explicit product decision that AgentBOX is the operator's primary send surface (not just a review layer over their inbox).

---

## 2. Schema Question

Answered even under no-go, per plan scope.

### The central problem

`mailbox.drafts.inbox_message_id` is declared `NOT NULL` (confirmed in `mailbox/dashboard/test/fixtures/schema.sql`). Every queue query — `listDrafts`, `getQueueWithUrgency`, `countUrgentDrafts` — performs an `innerJoin('inbox_messages as m', 'd.inbox_message_id', 'm.id')` (`lib/queries.ts`). A compose draft has no inbound anchor.

### The deeper blocker: send path is reply-only

This is the most significant finding of this spike and was not surfaced in the plan's current-state description.

**`MailBOX-Send` (Gmail)** — `Load Draft` node SQL (confirmed from `mailbox/n8n/workflows/MailBOX-Send.json`):

```sql
SELECT d.id, d.draft_body, d.inbox_message_id,
       m.message_id, m.thread_id, m.from_addr, m.to_addr, m.subject
FROM mailbox.drafts d
JOIN mailbox.inbox_messages m ON d.inbox_message_id = m.id
WHERE d.id = $draft_id AND d.status IN ('approved','edited')
```

The `Gmail Reply` node then executes:

```
operation: "reply"
messageId: "={{ $('Load Draft').item.json.message_id }}"
```

`message_id` is the inbound Gmail message ID. A compose draft supplies no inbound message; this node receives null and crashes.

**`MailBOX-Imap-Send` (IMAP)** — identical pattern. The `Send Email (SMTP)` node constructs a reply by prepending "Re:" to `original_subject` and addressing to `from_addr` of the inbound message (`mailbox/n8n/workflows/MailBOX-Imap-Send.json`).

**Consequence:** the plan's framing that "compose is only a new entry point into the existing send path" is not accurate. A compose workflow requires at minimum one new n8n workflow using Gmail `messages.send` (not `messages.reply`) before any dashboard plumbing makes sense. This materially increases effort beyond what the spike assumed.

**Webhook input contract:** `triggerSendWebhook` sends `{ draft_id }` only (`lib/n8n.ts:91`). The contract itself is minimal and transport-agnostic — a new MailBOX-NewSend workflow accepting the same `{ draft_id }` payload is clean. The coupling is in the workflow's internal SQL, not the webhook body.

### Option evaluation

| Option | Description | Inner-joins | Send-lock / cooldown | n8n contract |
|--------|-------------|-------------|----------------------|--------------|
| **(a) Nullable FK** | Make `inbox_message_id` nullable; add `compose_recipient`, `compose_subject` columns | All queue queries break — `listDrafts`, `getQueueWithUrgency`, `countUrgentDrafts` all inner-join | Survives if `account_id` stays NOT NULL | Both `Load Draft` nodes JOIN on `inbox_message_id`; returns no row for NULL — both workflows must be rewritten |
| **(b) Synthetic anchor** | Insert a synthetic `inbox_messages` row per compose draft | Preserves all joins without query changes | Inherits safety machinery unchanged | `Load Draft` returns a row, but `m.message_id` is fake — Gmail Reply node receives an invalid message ID and fails |
| **(c) Separate table + new workflow** | `compose_drafts` table; new `MailBOX-NewSend` n8n workflow using `messages.send` | Queue UI integration requires a UNION or view; existing queries untouched | Must explicitly inherit send-lock / cooldown in new workflow | New workflow uses Gmail new-message API; cleanest contract; no fake IDs |

**Preferred option if the project goes ahead: (c).** It is the only option that preserves existing queue queries, avoids faking Gmail threading, and maps correctly to Gmail's new-message API. Cost: one migration (new table), one new n8n workflow, queue-UI changes to surface compose drafts alongside inbound drafts. Not trivial.

### OAuth / Gmail send scope

The pipeline already sends Gmail replies; the existing OAuth token covers `gmail.send`, which authorizes both `messages.reply` and `messages.send`. No OAuth re-consent is needed for compose. This is not a blocker.

---

## 3. Phased Cut

Not produced. Step 1 returned no-go. Per plan scope, the phased cut is written only if Step 1 leans go. The send-path finding in Step 2 reinforces deferral by raising effort above what was scoped.

---

## Appendix: STOP condition audit

**Compose already exists?**
`grep -rn "compose" mailbox/dashboard/app --include="*.tsx" -l` → no files returned. STOP condition not triggered.

**n8n send workflow input contract determinable?**
Yes — confirmed from `MailBOX-Send.json` and `MailBOX-Imap-Send.json`. STOP condition not triggered.

**Drift check (plan Step 0):**
`git diff --stat ad6b760..HEAD -- mailbox/dashboard/lib/transitions.ts mailbox/dashboard/lib/n8n.ts mailbox/dashboard/app/api/drafts/` → empty. No drift.
