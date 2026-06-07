---
phase: 260510-7sp
plan: 01
subsystem: dashboard
tags: [ui, thread-history, kysely, react, typescript]
dependency_graph:
  requires: []
  provides: [thread_history field on DraftWithMessage, ThreadHistory component, conversation history in DraftDetail]
  affects: [dashboard/lib/types.ts, dashboard/lib/queries.ts, dashboard/lib/queries-thread.ts, dashboard/components/ThreadHistory.tsx, dashboard/components/EmailContext.tsx, dashboard/components/DraftDetail.tsx]
tech_stack:
  added: []
  patterns: [Kysely parallel Promise.all, Next.js App Router server component with client leaf (TimeAgo), discriminated union ThreadMessage, nested <details> group/group/msg Tailwind pattern]
key_files:
  created:
    - dashboard/lib/queries-thread.ts
    - dashboard/components/ThreadHistory.tsx
  modified:
    - dashboard/lib/types.ts
    - dashboard/lib/queries.ts
    - dashboard/components/EmailContext.tsx
    - dashboard/components/DraftDetail.tsx
decisions:
  - Two-SELECT merge in JS rather than SQL UNION ALL — inbox_messages.body vs sent_history.body_text column name divergence would have required sql.raw aliasing; JS merge keeps both branches fully typed
  - localeCompare on ISO-8601 strings for chronological sort — lex order == chronological order for ISO-8601; avoids Date construction on each comparison
  - received_at null-filter on inbound rows — preserves at: string invariant on ThreadMessageInbound without a cast; null-received_at rows have no chronological position anyway
  - Number(r.id) cast for sent_history.id (Int8) — thread sizes cap at ~14 rows per the live corpus; no precision loss risk
  - Optional thread_history on DraftWithMessage — existing fixtures and callers that build DraftWithMessage directly remain unaffected; only listDrafts/getDraft populate it
metrics:
  duration: ~25 minutes
  completed_date: "2026-05-10"
  tasks_completed: 3
  files_changed: 6
---

# Phase 260510-7sp Plan 01: Add Conversation History View to Dashboard — Summary

**One-liner:** Collapsed thread-history block above the inbound email toggle, sourced from a Kysely two-table fan-out (inbox_messages + sent_history) attached to DraftWithMessage.

## What Landed

### Types (`dashboard/lib/types.ts`)

Added `ThreadMessageInbound` / `ThreadMessageOutbound` discriminated union on `direction`, unified as `export type ThreadMessage`. Extended `DraftWithMessage` with `thread_history?: ThreadMessage[]` (optional — existing fixtures unaffected).

Key shape decisions:
- `at: string` on both branches (ISO-8601, pg type-parser override convention)
- `body: string | null` on both branches — `body_text` from `sent_history` is mapped to `body` in the query helper so the component layer has a single field name
- `from_addr: string` (non-nullable) on the outbound branch matches the DB NOT NULL constraint on `sent_history.from_addr`

### Query helper (`dashboard/lib/queries-thread.ts`)

`getThreadHistory(threadId, excludeInboxMessageId)`:
- Returns `[]` immediately when `threadId` is null (single-message thread, no block shown)
- Two parallel Kysely `selectFrom` calls — `inbox_messages` (excluding current row by id) and `sent_history` (all rows on thread)
- Merged in JS and sorted ascending by `at` via `localeCompare` (ISO-8601 lex == chronological)
- Fully parameterized via Kysely's query builder; no `sql.raw`, no string concat

### Query fan-out (`dashboard/lib/queries.ts`)

Both `listDrafts` and `getDraft` now populate `thread_history` before returning, so the queue page server render, the `/api/drafts` list route, and the `/api/drafts/[id]` single-draft route all return the same `DraftWithMessage` shape. No per-call wiring needed elsewhere.

### Component (`dashboard/components/ThreadHistory.tsx`)

- Outer `<details class="group ...">` mirrors the EmailContext inbound block pattern exactly — `list-none select-none`, `group-open:hidden` / `hidden group-open:inline` arrows
- Inner per-message `<details class="group/msg ...">` uses Tailwind's named-group scoping to avoid arrow-class collision with the outer toggle
- Direction badge uses `accent-blue` token for outbound (already in EditModal, ActionButtons, DraftDetail) and neutral `bg-bg-panel` for inbound — consistent with existing status pill convention
- Keys: `${direction}-${id}` compound — `inbox_messages.id` and `sent_history.id` are independent sequences and would collide on raw `id`
- Returns `null` on empty array — `EmailContext` can pass it unconditionally with no guard

### Wiring (`EmailContext.tsx`, `DraftDetail.tsx`)

- `EmailContext` gains `history?: ThreadMessage[]` prop (default `[]`)
- `<ThreadHistory messages={history} />` inserted between the header `<dl>` and the inbound body `<details>` — nothing moves, it's additive
- `DraftDetail` forwards `draft.thread_history` to `EmailContext`; the optional default handles the `undefined` case cleanly
- The `readOnly` (Sent view) path goes through the same `DraftDetail` render, so it gets the history block automatically

## Verify-Step Outcomes

| Step | Result |
|------|--------|
| `npx tsc --noEmit` (after each task) | Clean on our files; 8 pre-existing errors in `test/lib/rag-eval-harness.test.ts` (PersonaContext mock missing `business_description` — unrelated, pre-dates this task) |
| `npm test` | 251 passed, 71 skipped (DB-backed cases skip without `TEST_POSTGRES_URL`) |
| `npm run build` | `✓ Compiled successfully`, 18 static pages generated, no TS or lint errors |
| Manual UI smoke | Not performed — no Postgres tunnel open. Build gate is the acceptance criterion per plan. |

## Commits

| Hash | Message |
|------|---------|
| 19e2067 | feat(dashboard): add ThreadMessage type + getThreadHistory query helper |
| 0e588d8 | feat(dashboard): add ThreadHistory component |
| a4bc170 | feat(dashboard): mount ThreadHistory in EmailContext and DraftDetail |

## Known Stubs

None. The feature is fully wired: `getThreadHistory` queries live Postgres tables via Kysely; `ThreadHistory` renders the results; both `listDrafts` and `getDraft` populate the field. No placeholder data or TODO markers in source.

## Threat Flags

None. This change is read-only at the data layer (two SELECT queries) and additive at the UI layer. No new network endpoints, no new auth paths, no schema changes.

## Self-Check: PASSED

Files created:
- dashboard/lib/queries-thread.ts — confirmed by `git show 19e2067 --name-only`
- dashboard/components/ThreadHistory.tsx — confirmed by `git show 0e588d8 --name-only`

Files modified:
- dashboard/lib/types.ts, dashboard/lib/queries.ts — Task 1 commit 19e2067
- dashboard/components/EmailContext.tsx, dashboard/components/DraftDetail.tsx — Task 3 commit a4bc170

Commits confirmed in git log.
