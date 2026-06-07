# PRD — Calendar auto-scheduling on the incoming messages tab

> **Created:** 2026-06-07
> **Builds on:** MBOX-130 (calendar pre-read for `scheduling` drafts), MBOX-162 (operator booking link)
> **Status:** spec — no code yet, pending approval
> **Decisions locked:** v1 = *propose times in the reply* (approve-gated); upgrade `google_calendar` scope to `calendar.events` **now** + add re-consent, to unblock v2 event creation

## TL;DR

Most of "auto scheduling" **already exists** in the pipeline: inbound mail that
classifies as `scheduling` already triggers a Google Calendar availability read
and produces a draft reply that proposes concrete times + shares the operator's
booking link. The gaps are: (1) it's **not surfaced** as a feature on the
incoming messages (queue) tab — the operator can't see *why* a draft proposed
those times or that calendar availability was used; (2) it can **read** but not
**create** events. This PRD covers **surfacing v1 on the queue tab** + the
**`calendar.events` scope upgrade & re-consent now**, and specs **v2 event
creation on approval** as the follow-on the scope upgrade unblocks.

## What already exists (the pleasant surprise)

| Capability | Where | Status |
|---|---|---|
| `scheduling` category ("meeting/call/visit/calendar logistics") | `lib/classification/prompt.ts` | ✅ live |
| Availability read on scheduling inbound | `lib/calendar/calendar.ts` (`getCalendarSnapshot`), gated by `CALENDAR_CONTEXT_ENABLED` | ✅ live |
| Calendar block injected into draft prompt | `lib/drafting/prompt.ts:290` (`calendarBlock`) | ✅ live |
| Proposes times + shares booking link in reply | MBOX-162 booking-link block | ✅ live |
| Constrained decoding grammar for scheduling drafts | `scheduling.gbnf`, `CONSTRAINED_CATEGORIES` | ✅ live |
| Graceful degrade when calendar read fails | `drafts.scheduling_calendar_unavailable` flag | ✅ live |
| **Event creation (write)** | — | ❌ not built (needs `calendar.events`) |
| **Queue-tab surfacing of the scheduling/availability affordance** | `components/QueueClient.tsx` | ❌ not surfaced |

**Implication:** the heavy lifting (intent → availability → time-proposing draft)
is done. v1 is mostly **UI/observability** + the scope migration; the genuinely
new engineering is v2 event creation.

## Scope of this PRD

| Phase | What | New capability? |
|---|---|---|
| **v1 — surface on the queue tab** | Make the existing scheduling/availability flow visible & controllable on the incoming messages tab | No (UI over existing engine) |
| **Scope upgrade (now)** | `google_calendar`: `calendar.readonly` → `calendar.events`; re-consent flow | Yes (write grant) |
| **v2 — create event on approval** | On approving a scheduling draft, create the Google Calendar event + send reply | Yes (events.insert) |

## v1 — surface on the incoming messages tab

The engine runs today but is invisible. Add to `QueueClient.tsx` (the incoming
messages tab):

- **`Scheduling` badge** on rows the classifier tagged `scheduling`.
- **Availability affordance** on the row's draft/right-pane: show the calendar
  window the draft drew from (the same compact lines fed to `calendarBlock`), and
  an explicit **"availability used"** vs **"calendar unavailable"** indicator
  (read straight off `scheduling_calendar_unavailable`).
- **Manual override**: let the operator mark a non-`scheduling` message as
  scheduling (re-run the scheduling draft path) — covers classifier misses.
- No change to send: the proposed-times reply still goes through the normal
  **approve** gate.

> v1 ships value with **zero new scope** — but we're doing the scope upgrade in
> parallel (below) so v2 isn't blocked on a second re-consent round.

## Scope upgrade + re-consent (do now)

Creating events requires write access. Concrete change:

- `lib/oauth/google.ts` → `PROVIDER_SCOPE.google_calendar = 'https://www.googleapis.com/auth/calendar.events'`.
  (`calendar.events` is a superset for our `primary` `events.list` reads, so the
  existing availability flow keeps working **once re-consented**.)
- The consent URL builder already sets `access_type=offline` + `prompt=consent`
  (`google.ts:347`), so simply re-running the existing connect route
  (`app/api/oauth/google/[provider]/connect`) re-grants with the new scope and
  returns a fresh refresh token.
- The scope-verification at `google.ts:474` (`required = PROVIDER_SCOPE[provider]`)
  will now flag every **already-connected** account whose stored scope is the old
  `calendar.readonly` as **stale** → drive a dashboard **"Reconnect Google
  Calendar to enable scheduling"** banner in `Settings → Integrations`.

> ⚠️ **Migration risk:** the instant we change the scope constant, existing
> readonly grants are "stale scope." Depending on the verification's strictness,
> **calendar availability may stop feeding scheduling drafts for those accounts
> until they re-consent.** The graceful-degrade path already exists
> (`scheduling_calendar_unavailable` → draft falls back to no-calendar), so the
> failure mode is soft, but the re-consent banner must ship **with** the scope
> change, not after. Confirm whether verification hard-fails or soft-degrades on
> stale scope before flipping the constant.

## v2 — create event on approval (unblocked by the scope upgrade)

- New write helper in `lib/calendar/` (mirror the existing direct-fetch style —
  no googleapis SDK): `POST` to Calendar v3 `events.insert` on `primary`.
- Hook into the **approve** action for `scheduling` drafts: on approve, create
  the event (status configurable: `tentative` vs `confirmed`), then send the
  reply. Still operator-gated — no unattended calendar writes.
- **Attendees (required):** the event must support adding other people. At
  minimum auto-add the message **sender**; allow the operator to add/edit the
  attendee list before approving. Sent on `events.insert` via the `attendees[]`
  array. Covered by the `calendar.events` scope — **no extra scope needed**.
  - **Invite semantics:** populating `attendees` + `sendUpdates=all` makes Google
    send calendar **invitations** from the operator's account. So creating an
    event with attendees IS an outbound action — it must sit behind the same
    approve gate as the reply (it does). Operator can choose `sendUpdates`
    (`all` / `none`) per event; default TBD (see open questions).
- Surface the created event (and its attendees) back on the queue row (link to
  the event).
- Idempotency: guard against double-create on re-approve/retry (store the created
  `eventId` on the draft/message row).

## Components touched

| Layer | v1 | scope | v2 |
|---|---|---|---|
| `lib/oauth/google.ts` | — | scope constant + stale-scope detection | — |
| `Settings → Integrations` | — | re-consent banner | — |
| `components/QueueClient.tsx` + right-pane | scheduling badge, availability panel, manual override | — | created-event link |
| `lib/calendar/calendar.ts` | — | — | `createEvent` (events.insert, `attendees[]` + `sendUpdates`) |
| approve action (`lib/inbox-actions.ts` / drafts approve path) | — | — | create event (w/ attendees) → then send; idempotency |
| right-pane attendee editor | — | — | add/edit attendees (sender prefilled) before approve |
| migrations | — | — | store `calendar_event_id` on draft/message |

## Phasing

1. **v1** — queue-tab surfacing (badge, availability panel, manual override). No scope change. Lowest risk, immediate value.
2. **Scope upgrade** — flip `calendar.events`, ship re-consent banner, verify graceful degrade. Coordinate as one change.
3. **v2** — `createEvent` + approve-hook + idempotency + event link on the row.

## Open questions

- Event default status on creation: **tentative** (safer — client still confirms) vs **confirmed**?
- Who is the event organizer / which calendar (always operator `primary`, or per-account)?
- Attendee invites: default `sendUpdates` = `all` (Google emails the sender an invite on approve) vs `none` (operator's time blocked, no invite email)? Attendees themselves are **required** (decided) — this question is only about whether an invite email fires by default.
- Re-consent rollout: force banner immediately, or soft window where readonly still works until each account reconnects?
- Multi-account: scheduling availability/creation against which connected Google account when several are linked?

## Acceptance criteria

**v1**
- [ ] Incoming messages tab shows a `Scheduling` badge on scheduling-classified rows.
- [ ] The draft/right-pane shows the availability window used (or a clear "calendar unavailable").
- [ ] Operator can manually mark a message as scheduling and get a scheduling draft.
- [ ] No change to the approve→send gate.

**Scope**
- [ ] `google_calendar` scope is `calendar.events`; connect re-grants it.
- [ ] Stale-scope accounts get a reconnect banner; availability degrades gracefully until reconnect.

**v2**
- [ ] Approving a scheduling draft creates the event on the operator's calendar, then sends the reply.
- [ ] Event supports **attendees**: sender auto-added; operator can add/edit attendees before approve; attendees written via `events.insert` `attendees[]` (no extra scope).
- [ ] `sendUpdates` is operator-controllable (invite emails on/off per event).
- [ ] Event creation is idempotent (no duplicate on retry/re-approve).
- [ ] No unattended event creation — always behind approve.

## Out of scope

- Fully automatic (no-approval) scheduling — explicitly rejected; keeps the approve gate.
- Two-way calendar sync / managing/cancelling events after creation (v3+).
- Free/busy across non-primary or external calendars.
