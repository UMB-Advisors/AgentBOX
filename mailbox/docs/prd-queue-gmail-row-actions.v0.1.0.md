# PRD — Per-row Gmail actions on the approval queue

**Linear:** MBOX-369 (child of MBOX-122 · M5 — Production Box)
**Status:** Draft v0.1.0 · 2026-05-29
**Owner:** Dustin

## TL;DR

Bring Gmail's per-row hover actions — **archive, delete, mark-as-read, snooze** — to the dashboard approval queue. Archive / delete / mark-read **write through to the operator's real Gmail** via a new n8n workflow, mirroring the existing approve→send path. Snooze is **appliance-local** (Gmail has no snooze API): it hides the row until a chosen time, then resurfaces it. Multi-account aware (each action resolves its owning `account_id`'s Gmail credential). Ships in 6 phases; P0 is a live de-risk that gates the write path.

## Problem

The queue (`/dashboard/queue`) is a flat draft-approval list. The operator can approve / edit / reject / reclassify a draft, but cannot dispose of the underlying email the way Gmail lets them — archive it, trash it, mark it read, or defer it. As volume grows, the missing inbox-management verbs make the queue feel like a worse Gmail. This closes that gap without leaving the dashboard.

## Goals

- Gmail-style per-row actions on queue rows: archive, delete, mark-read, snooze.
- Archive / delete / mark-read take effect in **real Gmail** (so the operator's inbox stays in sync with what they triaged in the dashboard).
- Snooze defers the row locally and resurfaces it on schedule.
- Account-correct: an action on account B's message uses account B's Gmail credential.
- Audit-logged and idempotent, consistent with the send path.

## Non-goals

- Bulk/multi-select actions — that's MBOX-173, tracked separately (this PRD is per-row; schema/queries here are designed not to block it).
- True Gmail snooze parity (impossible — no API).
- Two-way label sync / pulling Gmail-side read/archive state back into the appliance (one-way write only; a future reconciler is out of scope).
- Permanent delete (`users.messages.delete`). We use Trash (recoverable) only.

## Gmail-side mapping

| Action | Gmail API call | Effect | Scope |
|---|---|---|---|
| Archive | `messages.modify` removeLabelIds `[INBOX]` | leaves Gmail inbox, stays in All Mail | `gmail.modify` |
| Delete | `messages.trash` | moves to Trash (auto-purged ~30d, recoverable) | `gmail.modify` |
| Mark read | `messages.modify` removeLabelIds `[UNREAD]` | clears unread | `gmail.modify` |
| Snooze | — none — | appliance-local hide+resurface; optional `MailBOX/Snoozed` label for visibility | n/a |

**Snooze is the load-bearing asymmetry.** Gmail's snooze is a first-party web feature with no public API. We approximate: store `snooze_until`, exclude the row from the queue while `snooze_until > now()`, resurface when it passes. Optionally apply a `MailBOX/Snoozed` label so the operator sees it flagged in Gmail too — but there is no unsnooze hook, so the label is cosmetic and must be cleared on resurface by our own workflow if used.

## Architecture

Reuses the proven approve→send shape:

```
Row action (client)
  └─> POST /api/inbox-messages/[id]/{archive|delete|mark-read|snooze}
        └─> UPDATE mailbox.inbox_messages  (state col, audit-logged)
        └─> [archive|delete|mark-read] → triggerMsgActionWebhook(action, account_id, message_id)
                                              └─> n8n MailBOX-MsgAction → Gmail modify/trash
        └─> [snooze] → set snooze_until only (no Gmail call)
```

- **State of record** stays in Postgres `inbox_messages`; Gmail is a downstream side-effect, same as send. A Gmail failure leaves a recoverable state (mirrors the StuckApproved pattern — don't lose the local intent on a remote error).
- **Multi-account:** `MailBOX-MsgAction` receives `account_id`; the workflow selects the matching Gmail credential. (Caveat: per `project_mbox162_v4_v5_shipped`, per-account Gmail creds are not yet wired — n8n still has a single appliance cred. Until multi-cred lands, all actions use the one live credential; acceptable for M1 single-account, must be revisited before account #2.)
- **Cooldown:** modify/trash are a *different quota bucket* from send and far cheaper, so we do **not** block them on the send cooldown. (Confirm in P0.)

## Data model — migration 042

`mailbox.inbox_messages` gains:

| Column | Type | Meaning |
|---|---|---|
| `archived_at` | `timestamptz null` | set when archived; row excluded from queue |
| `is_read` | `boolean not null default false` | local read flag |
| `snooze_until` | `timestamptz null` | row hidden while `> now()` |
| `deleted_at` | `timestamptz null` | set when trashed; row excluded |
| `gmail_action_state` | `text null` | `pending|ok|failed` for the last write-through (recoverability) |

Queue queries (`listDrafts`, `getQueueWithUrgency`) add: `WHERE archived_at IS NULL AND deleted_at IS NULL AND (snooze_until IS NULL OR snooze_until < now())`. Read filtering is a UI toggle, not a hard exclude (operator may want to see read items). Audit via the existing `state_transitions` trigger pattern if applicable, or a dedicated `inbox_message_actions` append table — decide in P1.

**Draft coupling (open):** when a row with a `pending` draft is archived/deleted, what happens to the draft? Proposed default: **archive keeps the draft** (operator may still want to send a reply, archiving just clears the inbox); **delete discards the draft** (`status=rejected`, reason `message_deleted`). Confirm before P1.

## Phases

| Phase | Deliverable | Gate |
|---|---|---|
| **P0** | Live de-risk on M1: confirm `gmail.modify` in the active credential's scope; confirm modify/trash quota is independent of send cooldown; confirm `inbox_messages` rows carry usable `message_id`. | Blocks P2/P3 write path |
| **P1** | Migration 042 + query filters + types + unit tests | codegen verify green |
| **P2** | `MailBOX-MsgAction` n8n workflow (action param, idempotent), active-gated | `mailbox-n8n-verify` exit 0 |
| **P3** | `POST /api/inbox-messages/[id]/{archive,delete,mark-read,snooze}` routes + `lib/n8n.ts` fan-out + `lib/queries-inbox-actions.ts` | route vitest pass |
| **P4** | UI: hover action icons on `DraftCard` + detail pane; 5s arm on delete; optimistic remove + undo toast | manual UAT |
| **P5** | Live smoke on M1; deploy; verify each action round-trips to Gmail | operator sign-off |

## Risks

- **OAuth scope narrower than `mail.google.com/`** → archive/delete/mark-read need re-consent (operator re-runs n8n Gmail OAuth). P0 catches this before any code.
- **n8n `$json` ref drift** (per `feedback_n8n_json_ref_breaks_on_inserted_node`) — use `$('Node').item.json.x` in the new workflow.
- **Idempotency** — double-clicks / retries must not double-trash. Guard with `gmail_action_state` + Gmail's own idempotent label semantics (modify is idempotent; trash on an already-trashed msg is a no-op 200).
- **Multi-account cred gap** — single live Gmail cred today; fine for M1, must gate before account #2.

## Open questions (need operator answers before P1)

1. Archive/delete vs. a pending draft — keep or discard the draft? (default proposed above)
2. Snooze presets — 1h / 3h / tomorrow 8am / custom? Default resurface behavior?
3. Mark-read — drop the row from the queue, or just clear the unread indicator and keep it?
4. Apply the cosmetic `MailBOX/Snoozed` Gmail label on snooze, or keep snooze purely local?
