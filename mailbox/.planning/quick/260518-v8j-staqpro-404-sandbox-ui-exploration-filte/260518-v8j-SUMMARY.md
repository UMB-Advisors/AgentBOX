---
quick_id: 260518-v8j
linear: STAQPRO-404
mode: quick
type: summary
scope: "Sandbox-only UI exploration for STAQPRO-404 dashboard queue UX overhaul. Phase 1 design contract for the Phase 2 dashboard/ port."
working_dir: /home/bob/mailbox/.claude/worktrees/staqpro-404
status: complete
completed_at: 2026-05-18
files_modified:
  - sandbox/src/fixtures/drafts.ts
  - sandbox/src/lib/urgency.ts
  - sandbox/src/components/FilterBar.tsx
  - sandbox/src/components/SortControls.tsx
  - sandbox/src/components/UrgencyBadge.tsx
  - sandbox/src/components/RedFlagHeader.tsx
  - sandbox/src/components/ClassificationOverride.tsx
  - sandbox/src/DigestPreview.tsx
  - sandbox/src/App.tsx
commits:
  - sha: 8e475e3
    task: 1
    summary: "feat(sandbox): add urgency signals + extended fixtures for STAQPRO-404"
  - sha: a557d90
    task: 2
    summary: "feat(sandbox): add FilterBar / SortControls / UrgencyBadge / RedFlagHeader"
  - sha: 361e650
    task: 3
    summary: "feat(sandbox): wire filter/sort/urgency/override into App + add override popover"
  - sha: f0a185c
    task: 4
    summary: "feat(sandbox): daily digest email body mockup at 'digest' view"
verify:
  pnpm_build: pass
  pnpm_typecheck: pass
  dashboard_diff: empty
---

# STAQPRO-404 Phase 1 — Sandbox UI exploration

Six deliverables from the Linear ticket are visible + interactive in
`sandbox/`. Build is green, typecheck is green, `dashboard/` diff is empty.

## Deliverables status

| # | Deliverable                                  | Component / file                              | Status |
|---|----------------------------------------------|-----------------------------------------------|--------|
| 1 | Filter chips bar (5 dimensions)              | `components/FilterBar.tsx`                    | shipped |
| 2 | Sort controls (newest / oldest / urgency)    | `components/SortControls.tsx`                 | shipped |
| 3 | Inline classification override               | `components/ClassificationOverride.tsx`       | shipped (popover) |
| 4 | Urgency badge per row + aggregate            | `components/UrgencyBadge.tsx`                 | shipped |
| 5 | Dashboard-wide red-flag header               | `components/RedFlagHeader.tsx`                | shipped (chip) |
| 6 | Daily digest email body mockup               | `DigestPreview.tsx`                           | shipped |

## Design decisions logged here for the Phase 2 port

- **Override UX = popover.** Reasoning in
  `components/ClassificationOverride.tsx` header. Picked over native
  `<select>` (loses CATEGORY_COLORS visual language) and context-menu
  (undiscoverable on touch).
- **Red flag = chip, not banner.** Reasoning in
  `components/RedFlagHeader.tsx` header. Banner steals vertical space and
  repeats per-row info; chip sits in the header band, glanceable, and
  disappears (visually) when the queue is under control.
- **Routing for digest = view-state extension, not new router.** App's
  existing `view` union extended from `'inbox' | 'tuning'` to add
  `'digest'`. No new dependency.
- **Urgency engine in `lib/urgency.ts`** as pure functions taking an
  optional `now`. All derivations (signals, score, route, bands) are
  deterministic; production port can drop the same surface into
  `dashboard/lib/`.
- **Filter chip counts off the UNFILTERED set.** So chip counts don't
  collapse to zero once a filter is applied — operator can always see
  what's available before committing.
- **Override feeds urgency derivation in real time.** Overrides apply to
  the row BEFORE `rowDerived()` runs, so flipping a category to/from
  `escalate` updates the row's signals, score, and red-flag count
  immediately.

## Urgency signal contract

Locked in for the Phase 2 port:

| Signal     | Derivation                                                                | Weight |
|------------|---------------------------------------------------------------------------|--------|
| `escalate` | `classification_category === 'escalate'`                                  | 3      |
| `vip`      | explicit `is_vip: true` (only non-derivable; needs schema column in prod) | 3      |
| `aged`     | `status === 'pending'` AND `now - received_at > 4h`                       | 2      |
| `low_conf` | `classification_confidence !== null && < 0.75`                            | 1      |

"Urgent untouched" = `status === 'pending' && urgencyScore > 0`. Tiebreaker
on urgency sort = older `received_at` wins. Aggregate badge fires at 2+
signals on the same row.

## Fixture coverage

Every category and every urgency signal hits at least one row. The
`>=2-signal` aggregate demo row is id 105 (vip + aged + low_conf, 3 signals).
Two fixture timestamps were re-anchored in Task 4 to keep the digest's
sent-in-24h and by-category sections non-empty against the
`2026-05-18T12:00Z` digest clock (documented inline in `fixtures/drafts.ts`).

## Deviations from plan

- **Fixture timestamp adjustments in Task 4 (Rule 1).** The plan explicitly
  said "if existing fixtures don't yield a non-empty digest, fix by
  adjusting fixture timestamps in Task 1." Two rows touched in Task 4
  rather than Task 1 to keep Task 1's commit cleanly scoped to "add
  signal coverage" — the Task 4 commit message documents both
  adjustments and their reasoning. Net effect: same as if it had landed
  in Task 1.

No other deviations. All four task verify gates (`pnpm exec tsc -b --noEmit`,
final `pnpm build`) passed clean. No auth gates encountered. No
architectural questions raised.

## Out of scope (per plan)

- Backend wiring (filter/sort URL params, override persistence, digest
  cron, RAG-aware urgency score) — Phase 2 dashboard port.
- Screenshots — captured by the orchestrator after execution, NOT planned
  here.
- Eval / a11y / mobile breakpoints — exploratory phase, not gated.

## How to run

```bash
cd sandbox && pnpm dev
# http://localhost:5173/
# - Inbox view: filter chips, sort segmented control, red-flag chip,
#   per-row UrgencyBadge, inline ClassificationOverride popover.
# - Sidebar → "Digest preview" → the mocked daily-digest email body.
```

## Self-Check: PASSED

- All 4 commits present on `dustin/staqpro-404`:
  - `8e475e3` (Task 1), `a557d90` (Task 2), `361e650` (Task 3), `f0a185c` (Task 4).
- All 9 files in `files_modified` exist.
- `pnpm build` exits clean (last run dist sizes: index.html 0.46kB, css
  37.12kB, js 324.13kB).
- `git diff master --stat -- dashboard/` returns empty.
- `git diff master --stat -- sandbox/` returns exactly the 9 files in
  `files_modified`.
