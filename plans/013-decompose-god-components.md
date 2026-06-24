# Plan 013: Decompose QueueClient.tsx (1,068 lines) and the status page (1,051 lines)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- mailbox/dashboard/components/QueueClient.tsx mailbox/dashboard/app/status/page.tsx`
> If either file changed materially since planning, STOP — this plan's line
> references will be wrong and a stale decomposition is worse than none.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED — the queue is the primary operator surface; a regression here
  is customer-visible. Do NOT start this before plans 001–003 are DONE.
- **Depends on**: plans/001-root-ci-gate.md, plans/003-approve-send-integration-test.md
- **Category**: tech-debt
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

Two files are ~2.5× larger than anything else in the dashboard and combine
many concerns in one render tree. `components/QueueClient.tsx` (1,068 lines)
holds the approval queue's polling, folder/mode state, selection, keyboard
handling, busy/toast state, and all rendering; `app/status/page.tsx`
(1,051 lines) inlines every status card. Every feature touching the queue
(recent: calendar surfacing, job outcomes, per-job model selectors) lands in
the same file, so diffs are hard to review and state interactions are hard to
reason about. The goal is mechanical extraction with **zero behavior change**.

## Current state

- `mailbox/dashboard/components/QueueClient.tsx` structure (line refs at
  planned-at SHA): module constants :22-32 (`POLL_INTERVAL_MS = 30_000`,
  `STUCK_APPROVED_THRESHOLD_MS`, localStorage keys, panes autosave id);
  `modeForFolder(folder)` :52; `export function QueueClient({...})` :78;
  ~10 `useState` hooks :95-133 (cooldown, removed-set, busy, rowBusyId,
  redraftSeedBody, toast, selectedId, sortOrder, accountFilter); five
  `useEffect` blocks at :135, :245 (the poll interval — `setInterval(tick,
  POLL_INTERVAL_MS)` at :250), :268, :295, :695.
- `mailbox/dashboard/app/status/page.tsx` — single render tree, ~8 inline
  helpers, no subcomponents.
- Conventions: components in `components/` (PascalCase files), hooks are not
  yet a convention in this repo (no `hooks/` dir — creating
  `components/queue/hooks.ts` or `lib/hooks/` is the decision point; prefer
  `components/queue/` so related parts stay together). Biome enforces style;
  TypeScript strict.
- Tests: there are no component render tests today (vitest covers routes/lib).
  The safety net is typecheck + the route suites + manual smoke.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `cd mailbox/dashboard && npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Tests | `TEST_POSTGRES_URL=... npm test` | all pass |
| Build (hydration sanity) | `npm run build` | exit 0 |
| Line counts | `wc -l components/QueueClient.tsx components/queue/*.tsx app/status/page.tsx app/status/components/*.tsx` | see done criteria |

## Scope

**In scope**:
- `mailbox/dashboard/components/QueueClient.tsx` (shrink)
- `mailbox/dashboard/components/queue/` (create: extracted hooks + leaf components)
- `mailbox/dashboard/app/status/page.tsx` (shrink)
- `mailbox/dashboard/app/status/components/` (create: extracted cards)

**Out of scope**:
- ANY behavior change: poll interval, keyboard shortcuts, localStorage keys,
  pane autosave ids, fetch endpoints, state semantics — all byte-identical.
- API routes, lib/, other components.
- Adding a component-testing framework (jsdom/playwright) — see Maintenance.

## Git workflow

- Branch: `chore/decompose-queue-status`
- One commit per extraction (5–8 commits), each leaving the app green:
  `refactor(dashboard): extract useQueuePolling from QueueClient` etc.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract pure helpers and constants (lowest risk)

Move module-level constants (:22-32) and pure functions (`modeForFolder` :52,
plus any others found) to `components/queue/constants.ts` and
`components/queue/utils.ts`; re-import. Identical for status page inline pure
helpers → `app/status/components/utils.ts`.

**Verify**: `npm run typecheck && npm run lint && npm run build` → exit 0.

### Step 2: Extract custom hooks from QueueClient

One hook per commit, in dependency order, each a verbatim relocation of the
existing logic (state + its effects), e.g.:
- `useQueuePolling` — the tick/`setInterval` effect at :245-? plus the state
  it feeds (drafts/stuck/cooldown), including the existing visibility
  handling.
- `useKeyboardNav` — the keyboard effect (locate via
  `grep -n "keydown" components/QueueClient.tsx`).
- `usePaneLayout` — the localStorage pane/right-pane persistence
  (`RIGHT_PANE_PREF_KEY`, `PANES_AUTOSAVE_ID`).

Rule: a hook extraction must not reorder hook calls relative to each other
(React hook order is load-bearing). Keep the call sequence in `QueueClient`
identical to the original `useState`/`useEffect` order.

**Verify after each**: `npm run typecheck && npm run build` → exit 0.

### Step 3: Extract leaf render components

Split the JSX into `components/queue/QueueList.tsx`, `QueueDetail.tsx`,
`QueueToolbar.tsx` (names indicative — follow the natural seams in the JSX;
each receives props, owns no fetch). `QueueClient` remains the container:
state + hooks + layout.

**Verify**: typecheck/build, plus `npm test` full suite.

### Step 4: Status page

Same treatment: each visually distinct card/section →
`app/status/components/<Card>.tsx`; `page.tsx` becomes data assembly + grid.

**Verify**: typecheck/build/test as above.

### Step 5: Manual smoke checklist for the operator

List in your report (cannot be automated here): queue loads; folder switching;
approve/reject/redraft buttons; keyboard nav; pane resize persists across
reload; status page renders all cards. Recommend the operator runs `npm run
dev` and walks it before merging.

## Test plan

No new automated tests (no component test rig exists). The gates are
typecheck, build, the full vitest suite, and the manual checklist. Keep every
commit independently green so `git bisect` works if a regression surfaces.

## Done criteria

- [ ] `wc -l components/QueueClient.tsx` ≤ 300; `wc -l app/status/page.tsx` ≤ 250
- [ ] No behavior-bearing string changed: `grep -n "30_000\|RIGHT_PANE_PREF_KEY\|PANES_AUTOSAVE_ID" -r components/` still finds the same values (relocated is fine)
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all exit 0
- [ ] Each commit builds green independently
- [ ] `plans/README.md` status row updated; manual smoke checklist delivered

## STOP conditions

- Drift check fails (these files churn — recent features landed in both).
- An extraction forces changing hook order or splitting one `useEffect`'s
  logic across components — that's a redesign, not a relocation; report.
- `npm run build` warns about hydration/client-boundary changes
  (`'use client'` placement) you didn't anticipate.

## Maintenance notes

- Follow-up worth its own decision: a component test rig (vitest +
  testing-library) — extraction makes leaf components testable; that value is
  only realized if the rig gets added.
- Reviewer: diff each commit for *moved* vs *changed* lines; `git diff
  --color-moved=dimmed-zebra` makes verbatim relocation auditable.
- New queue features should land in the extracted seams from now on; if
  QueueClient grows past ~400 lines again the decomposition didn't take.
