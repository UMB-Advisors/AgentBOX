# Plan 011: Investigate (and wire if absent) token refresh-and-retry on calendar 401s

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- mailbox/dashboard/lib/calendar/calendar.ts mailbox/dashboard/lib/oauth/google.ts`
> On any mismatch with the excerpts below, STOP.

## Status

- **Priority**: P3
- **Effort**: S (investigate) → S–M (fix, only if the gap is confirmed)
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (investigate-grade — the original audit finding partially
  collapsed under vetting; see below)
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

An audit finding claimed the calendar code swallows errors and renders 401s
as an empty calendar. Vetting showed the code is better than claimed: fetches
discriminate `token_expired` / `rate_limited` / `fetch_failed` reasons, and
`lib/oauth/google.ts` has a working token-refresh function with typed
`OAuthTokenError` (`transient` vs `auth`). **What remains unverified** is
whether the calendar fetch path actually *uses* the refresh function when an
access token expires mid-session, or whether an expired access token degrades
the calendar until some other process refreshes it. Google access tokens live
~1 hour; if no refresh-retry exists on this path, the calendar panel spends
much of its life in `token_expired`. This plan answers that question and
closes the gap only if it is real.

## Current state

- `mailbox/dashboard/lib/calendar/calendar.ts:252-260` — status
  discrimination exists (excerpt, verbatim):
  ```ts
  if (res.status === 429) {
    return { reason: 'rate_limited', lines: [] };
  }
  if (res.status === 401 || res.status === 403) {
    return { reason: 'token_expired', lines: [] };
  }
  ```
  Same pattern at :481-483. A range-fetch helper at :340-355 returns
  `{ ok: false, status }` without refresh.
- `mailbox/dashboard/lib/oauth/google.ts:~510-545` — a refresh function
  (returns a fresh `access_token`; throws `OAuthTokenError` with kind
  `auth` for 400/401 = revoked refresh token, `transient` for 5xx).
- Unknown (the investigation): where `conn.access_token` /
  `accessToken` passed into these fetches comes from — find the connection
  loader (grep `access_token` in `lib/calendar/` and `lib/oauth/`) and
  whether it refreshes proactively (expiry timestamp check) or not at all.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Trace callers | `grep -rn "token_expired\|refreshAccess\|access_token" mailbox/dashboard/lib/calendar/ mailbox/dashboard/lib/oauth/ mailbox/dashboard/app/api/calendar/` | the full call graph |
| Typecheck/lint/test | `cd mailbox/dashboard && npm run typecheck && npm run lint && npm test` | clean / pass |

## Scope

**In scope**:
- Investigation (read-only) across `lib/calendar/`, `lib/oauth/`,
  `app/api/calendar/`
- If the gap is confirmed: `lib/calendar/calendar.ts` (refresh-retry), the
  connection-loading helper it uses, and a test file

**Out of scope**:
- UI components (`components/right-pane/CalendarPanel.tsx`)
- The OAuth connect/consent flow; scopes
- Any non-calendar consumer of the google OAuth lib (draft pipeline) — if the
  fix has to touch shared token-loading code used by the pipeline, STOP first

## Git workflow

- Branch: `fix/calendar-refresh-on-401`
- Commit: `fix(calendar): refresh access token and retry once on 401/403`
  (only if the fix phase happens)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Answer the question

Trace how the access token used by the calendar fetches is obtained and
refreshed. Outcome A: a loader already refreshes (proactively by expiry or
reactively on 401) → the audit finding is fully moot; update
`plans/README.md` marking this plan REJECTED with one line ("refresh exists
at <file:line>") and stop here. Outcome B: no refresh on this path → proceed.

**Verify**: you can cite file:line for where the token enters the fetch and
either the refresh site (Outcome A) or its absence (Outcome B).

### Step 2 (Outcome B only): Refresh-and-retry once

At each calendar fetch site that maps 401/403 → `token_expired` (the two
excerpted sites and the range-fetch helper), wrap with a single
refresh-and-retry: on first 401/403, call the existing refresh function from
`lib/oauth/google.ts`, persist the new access token the same way the
connection loader stores it, retry the fetch once; only if the retry also
fails (or the refresh throws `OAuthTokenError` kind `auth`) return
`token_expired`. Factor the wrapper as one helper so the three sites share
it. Match the file's existing error-object return style — no thrown
exceptions across the existing `reason` contract.

**Verify**: `npm run typecheck && npm run lint` → exit 0.

### Step 3 (Outcome B only): Tests

New `test/lib/calendar-refresh.test.ts` (vitest; mock global fetch):
1. First call 401, refresh succeeds, retry 200 → `reason: 'ok'` (or items
   returned), exactly one refresh call.
2. Refresh throws kind `auth` → `token_expired`, no infinite retry.
3. 429 → `rate_limited` untouched by the wrapper.

**Verify**: `npm test -- calendar-refresh` → 3 passing.

## Done criteria

- [ ] Question answered with citations (commit message or README note)
- [ ] If Outcome A: plan marked REJECTED in `plans/README.md`, no code change
- [ ] If Outcome B: wrapper in place at all three sites, 3 tests pass,
      typecheck/lint clean, no files outside scope modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- The token loader is shared with the draft/classification pipeline and the
  fix would change its behavior — report the coupling first.
- Refresh-token storage requires a schema change (no current column for the
  rotated access token) — report; do not add migrations under this plan.

## Maintenance notes

- If Outcome B lands: the wrapper is the single place retry policy lives;
  resist adding per-site retries later.
- Reviewer: check the retry cannot loop (one retry, hard).
