---
phase: 02-email-pipeline-core
plan: 02
plan_version: v2
subsystem: database
tags: [postgres, migrations, schema, drizzle-replacement, raw-sql, pg-driver, kysely, typescript]
forward_pointer: "Hand-rolled pg.Pool query helpers described below were superseded 2026-05-01 by Kysely (typed query builder) per the Dashboard ORM ADR in `.planning/STATE.md`. Migrations runner and the .sql files unchanged. STAQPRO-136 has the migration commits."

requires:
  - phase: 01-infrastructure-foundation
    provides: live mailbox.inbox_messages and mailbox.drafts in Phase 1 dashboard sub-project
provides:
  - mailbox.classification_log table (D-21)
  - mailbox.sent_history and mailbox.rejected_history archival tables (D-19)
  - mailbox.persona table (D-11) with single-row-per-customer shape
  - mailbox.onboarding state machine (D-16) seeded with pending_admin
  - mailbox.drafts extended to D-17 queue-record shape (denormalized email fields, classification fields, RAG refs, auto_send_blocked, approved_at, sent_at)
  - awaiting_cloud DraftStatus value (D-03) on drafts CHECK constraint
  - dashboard/migrations/runner.ts forward-only migration runner with mailbox.migrations tracking
  - dashboard/lib/types.ts extended with Phase 2 interfaces
  - dashboard/lib/queries-onboarding.ts and queries-persona.ts query helpers
affects: [02-03 imap-ingestion, 02-04 classification, 02-05 rag, 02-06 persona-extract, 02-07 draft-generation, 02-08 onboarding-wizard]

tech-stack:
  added:
    - tsx (dev) — runs migrations/runner.ts under Node 20 alpine
  patterns:
    - "Forward-only versioned SQL migrations tracked in mailbox.migrations table; runner is idempotent"
    - "Hand-rolled pg.Pool query helpers (lib/queries-*.ts) instead of an ORM — matches existing lib/queries.ts pattern"
    - "Non-destructive evolution: legacy inbox_messages.classification columns left in place so existing code keeps working while classification_log carries new writes"

key-files:
  created:
    - dashboard/migrations/runner.ts
    - dashboard/migrations/001-extend-drafts-add-status-and-timestamps-v1-2026-04-27.sql
    - dashboard/migrations/002-create-classification-log-v1-2026-04-27.sql
    - dashboard/migrations/003-evolve-drafts-to-queue-shape-v1-2026-04-27.sql
    - dashboard/migrations/004-create-sent-and-rejected-history-v1-2026-04-27.sql
    - dashboard/migrations/005-create-persona-v1-2026-04-27.sql
    - dashboard/migrations/006-create-onboarding-and-seed-v1-2026-04-27.sql
    - dashboard/lib/queries-onboarding.ts
    - dashboard/lib/queries-persona.ts
  modified:
    - dashboard/lib/types.ts
    - dashboard/package.json

key-decisions:
  - "Replace v1's drizzle-orm + Express stack with raw SQL migrations + pg.Pool query helpers — matches the live Next.js dashboard architecture per the 2026-04-27 ADR"
  - "Evolve mailbox.drafts in place (D-17 columns) rather than create a parallel draft_queue table — preserves working queue API and existing rows"
  - "Keep legacy inbox_messages.classification columns alongside new classification_log — backward compatible with existing lib/queries.ts JSON projection"
  - "Migration runner uses pg Client (one-shot) instead of getPool() — runs as a separate ephemeral process, no connection pool needed"
  - "Seed onboarding with pending_admin via ON CONFLICT DO NOTHING so re-runs are idempotent"

patterns-established:
  - "SQL migrations: numbered NN-name-vN-DATE.sql, applied lexically, tracked in mailbox.migrations(version PK, applied_at)"
  - "Query helpers: top-of-file SQL constants (UPPER_SNAKE_SQL), exported async wrappers using shared getPool() from lib/db.ts"
  - "Forward-only schema strategy: ADD COLUMN IF NOT EXISTS; CHECK constraints DROP+ADD by name; never DROP columns in this milestone"

requirements-completed: [MAIL-04, MAIL-11, RAG-01, PERS-01, ONBR-01, APPR-01, APPR-02]

duration: ~4h (execution spread across two sessions, 2026-04-27)
completed: 2026-04-27
---

# Phase 02 Plan 02 (v2): Schema Foundation Summary

**Postgres schema brought up to Phase 2 D-17 / D-19 / D-21 shape via 6 forward-only migrations, with TS types and query helpers for downstream plans 02-03 through 02-08.**

## Performance

- **Duration:** ~4h across two sessions
- **Started:** 2026-04-27 (morning, after re-scope from v1)
- **Completed:** 2026-04-27 (afternoon)
- **Tasks:** 9 of 10 (task 10 verification ran live during tasks 2-7 execution; treated as already-validated)
- **Files modified:** 11 (1 runner, 6 SQL migrations, 1 types.ts, 2 query helpers, 1 package.json)

## Accomplishments

- Live `mailbox` schema now carries every D-17 / D-19 / D-21 column the rest of Phase 2 needs — drafts evolved in place with no data loss; existing dashboard queue API still works.
- `mailbox.classification_log`, `sent_history`, `rejected_history`, `persona`, and `onboarding` tables created and seeded; `onboarding.stage = 'pending_admin'` on `customer_key='default'`.
- TypeScript types and parameterized query helpers (`queries-onboarding.ts`, `queries-persona.ts`) ready for 02-08 onboarding wizard and 02-06 persona refresh.
- Migration runner is idempotent and re-runnable; subsequent migrations in this milestone can be added as `dashboard/migrations/NNN-*.sql` and applied via `npm run migrate`.

## Task Commits

1. **Task 1: migration runner + ephemeral migrate service** — `47962fe` (feat)
2. **Tasks 2-7: six SQL migrations for Phase 2 schema** — `df524d3` (feat)
   - **Migration 002 fix: normalize legacy classifications** — `de69f92` (fix)
   - **Migration 003 fix: normalize legacy classifications in drafts backfill** — `687b24e` (fix)
3. **Task 8: Phase 2 type interfaces** — `e4e30ec` (feat)
4. **Task 9: onboarding and persona query helpers** — `ae2b362` (feat)

**Plan metadata:** `c1392db` (plan: re-scope 02-02 for Next.js + raw pg)

## Files Created/Modified

- `dashboard/migrations/runner.ts` — Forward-only migration runner (pg.Client, transactional per-file, mailbox.migrations tracking).
- `dashboard/migrations/001..006-*.sql` — 6 migrations: extend drafts (status + timestamps), create classification_log, evolve drafts to D-17 shape, create sent/rejected history, create persona, create onboarding+seed.
- `dashboard/lib/types.ts` — Added `ClassificationCategory`, `DraftSource`, `DraftStatusV2`, `ClassificationLog`, `SentHistory`, `RejectedHistory`, `Persona`, `OnboardingStage`, `Onboarding`. Existing `Draft`/`InboxMessage`/`DraftWithMessage`/`DraftStatus` preserved.
- `dashboard/lib/queries-onboarding.ts` — `getOnboarding`, `setStage`, `setAdmin`, `setEmail`, `isLive`.
- `dashboard/lib/queries-persona.ts` — `getPersona`, `upsertPersona`.
- `dashboard/package.json` — Added `migrate` script and `tsx` dev dependency (committed in task 1).

## Verification

- All 6 migrations applied cleanly to live Jetson Postgres on 2026-04-27 (per STATE.md and `bb6fd7e`); two follow-up fixes (`de69f92`, `687b24e`) handled legacy `classification` values that didn't match the new MAIL-05 CHECK list.
- `mailbox.migrations` lists versions 001..006.
- `mailbox.onboarding` seed row present: `customer_key='default'`, `stage='pending_admin'`.
- `npm run typecheck` exits 0 with new types and queries in place.
- Existing `https://mailbox.heronlabsinc.com/dashboard/api/drafts` still serves the queue (legacy `inbox_messages.classification` left in place; `lib/queries.ts` JSON projection unchanged).

## Notes / Deviations

- Task 10 (run+verify on live Jetson) was performed inline during tasks 2-7 execution rather than as a separate atomic step. The migration runner's idempotent-by-version-tracking design means re-running on Jetson is safe and remains the intended OTA pattern.
- Two real-world fixes (`de69f92`, `687b24e`) were needed against legacy data: existing `inbox_messages.classification` rows contained category names outside the MAIL-05 list (e.g. older labels from the dashboard sub-project), which violated the new CHECK on `classification_log` and on `drafts.classification_category`. Both fixes coerce out-of-list values to `'unknown'` during backfill — original raw values remain in `inbox_messages.classification` for historical inspection.
- Two `package.json` changes (script + tsx devDep) were bundled into task 1's commit (`47962fe`) instead of being a standalone task 1b. Acceptable per CLAUDE.md "smallest correct change" principle.
