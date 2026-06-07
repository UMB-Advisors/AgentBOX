# Quick — Vault-drift correction: STAQPRO-271 / 3-dupes framing

**Date:** 2026-05-22 (UTC; Pacific 2026-05-21 late)
**Trigger:** Standup framed MailBOX next-task as "patch raw-webhook to honor STAQPRO-271 dedupe gate." Investigation invalidated the premise.
**Type:** Investigation + vault correction (no production code change).

---

## What the vault said

From `Memory/Projects/UMB Advisors MailBOX.md` (2026-05-21 entry) and `Memory/_index.md`:

> Latent 2nd bug: `Mark Sent` had no creds in JSON, never observed because `Load Draft` failed first.
> 3 duplicate replies sent to Dustin during debugging (raw webhook bypasses STAQPRO-271
> "may have already sent" gate — Dustin's email was a test).

This framing implied:
- An idempotency hole in `MailBOX-Send` (raw-webhook callers bypass a dedupe gate)
- A latent missing-creds bug on the `Mark Sent` node

## What the code + DB actually say

### STAQPRO-271 is not a dedupe gate
`dashboard/lib/transitions.ts:30-56` + `dashboard/CLAUDE.md` gotcha section confirm STAQPRO-271 is two things:
1. **Gmail rate-limit cooldown gate** — `getGmailCooldown()` consults `mailbox.system_state`; returns 429 before any send if cooldown is active.
2. **`drafts.error_message` persistence** — writes send-failure detail so `StuckApproved.tsx` has forensic context.

The "may have already sent — verify in Gmail Sent" string is a **UI warning** in `StuckApproved.tsx`'s 5-second arm window before the operator can re-fire a stuck-`approved` draft. Not a server gate.

### MailBOX-Send already has correct idempotency
`n8n/workflows/MailBOX-Send.json` (and live `workflow_entity.nodes` on M1) both show:
- **Load Draft** query: `WHERE d.id = ... AND d.status IN ('approved', 'edited')` — any other state (including `'sent'`) drops to `Respond Not Found`.
- **Already Sent?** IF node: `$json.sent_gmail_message_id` notEmpty → skip Gmail Reply, just re-run Mark Sent (belt-and-suspenders against a crash between Gmail Reply and Mark Sent).
- **Mark Sent** UPDATE persists `sent_gmail_message_id = Gmail Reply's returned message id`, closing the loop.

Commit `7d75145 — feat(send): persist sent_gmail_message_id on Mark Sent (outbound idempotency key)` deliberately built this design.

### The 3 dupes were 3 different drafts
M1 `execution_entity` shows MailBOX-Send executions 9198/9199/9200 on **2026-05-18 20:20 UTC** (4 days before yesterday), 3 seconds apart, all `success`. `execution_data` body extraction:

| exec | draft_id | inbox_message_id |
|------|----------|-------------------|
| 9198 | 62 | 63878 |
| 9199 | 53 | 61021 |
| 9200 | 13 |  9733 |

Three different drafts → three different replies. **Not a dedupe failure** — three legitimate sends that someone hand-fired in 3 seconds during a debugging session.

### Date conflation
Vault treated this as a 2026-05-21 incident. Actual: M1 dupes were **2026-05-18**; yesterday's M2 work (exec 5209, first `sent_history` row on M2) was unrelated.

### The only actual drift
`n8n/workflows/MailBOX-Send.json` on disk strips the Postgres `credentials` block from both `Load Draft` and `Mark Sent`. Live `workflow_entity.nodes` on M1 has them wired correctly (`id=JFX4tvrffvKnTouV`, name `MailBox Postgres`). The runtime is fine; the round-trip is leaky.

This is a **STAQPRO-139 round-trip script bug**, not a runtime bug — the saved JSON only matters if/when a fresh n8n instance imports it (e.g. customer #3 provisioning).

## Outcome

No production code change.

1. **Vault corrections** — see sibling file `vault-corrections.md` for the exact diffs to apply to `Memory/Projects/UMB Advisors MailBOX.md`, `Memory/_index.md`, and `Daily Notes/2026-05-21 MailBOX — Send pipeline unblocked...md`.
2. **Memory rule reinforced** — `feedback_vault_todo_drift` fired correctly. Investigation took ~6 tool calls and saved a fix to a non-existent bug.
3. **Follow-up filed** — STAQPRO-139 round-trip credential stripping needs a fix before customer #3 provisioning. Filed as a candidate ticket in the vault-corrections doc; raise with Dustin or self-assign on the next MailBOX touch.

## What MailBOX work is actually next

With the original target item gone, the remaining MailBOX backlog (from Memory/Projects):

- **STAQPRO-177 remaining ACs** — edit/reject + sustained-power burst measurement (operator-owed, needs Jetson bench time, not a coding session today)
- **STAQPRO-198** — Dustin's RAG eval harness (PR #32 merged, not yet run; 2× 1-2h passes on Bob)
- **STAQPRO-132** — Onboarding docs + video (deferred by "save onboarding for last")
- **STAQPRO-139 round-trip credentials fix** (newly raised by this investigation)

None block customer #2 stability. Recommend pivoting back to the standup's #3 (AutoCSR `/gsd` on CSR-1/3/13) or #4 (Optimus PR #217 merge) unless the eval harness run is appealing.
