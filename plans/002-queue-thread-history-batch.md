# Plan 002: Kill the queue N+1 — batch thread-history loading and index thread_id

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- mailbox/dashboard/lib/queries.ts mailbox/dashboard/lib/queries-thread.ts mailbox/dashboard/migrations/ mailbox/dashboard/test/fixtures/schema.sql`
> On any mismatch with the excerpts below, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001-root-ci-gate.md (CI gate validates the change)
- **Category**: perf
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

The queue list endpoint loads up to 50 drafts and then issues **2 additional
queries per draft** (thread history: one SELECT on `inbox_messages`, one on
`sent_history`) — ~100 round-trips per render. The frontend polls this every
30 seconds (`components/QueueClient.tsx:22`, `POLL_INTERVAL_MS = 30_000`).
The whole stack runs on an 8GB Jetson Orin Nano sharing RAM/CPU with Postgres,
Qdrant, n8n, and a local LLM; this query storm contends with the inference
pipeline. Additionally, neither `inbox_messages.thread_id` nor
`sent_history.thread_id` has an index, so each of those queries is a
sequential scan. Fix both: batch the two queries across all drafts, and add
the indexes.

## Current state

- `mailbox/dashboard/lib/queries.ts:80-86` — the N+1 (excerpt, verbatim):
  ```ts
  const withHistory = await Promise.all(
    drafts.map(async (d) => ({
      ...d,
      thread_history: await getThreadHistory(d.message.thread_id, d.message.id),
    })),
  );
  return withHistory;
  ```
- `mailbox/dashboard/lib/queries-thread.ts` — `getThreadHistory(threadId, excludeInboxMessageId)`
  issues two parallel Kysely SELECTs (one per table) for a **single** thread,
  then merges/sorts in JS. Doc comment notes: "Thread sizes cap at ~14
  locally". Keep this function — single-draft callers (`getDraft`) still use it.
- `mailbox/dashboard/migrations/` — numbered SQL files, latest is
  `049-create-job-outcomes-v1-2026-06-07.sql`. Header convention (excerpt):
  ```sql
  -- Migration 049 — MBOX-462: Agent Job outcomes ledger (per company/department).
  -- WHAT: ...
  -- WHY:  ...
  ```
  Runner: `migrations/runner.ts`, invoked via `npm run migrate`.
- `mailbox/dashboard/test/fixtures/schema.sql` — CI schema snapshot; its top
  comment says to refresh it when migrations land. There is currently **no
  index on `thread_id`** in any migration or in the fixture (verified by grep).
- Tables are in the `mailbox` schema (e.g. `mailbox.inbox_messages`).
- Conventions: Kysely query builder (no raw SQL in lib/queries*), TypeScript
  strict, biome lint, vitest tests under `test/`.

## Commands you will need

(Working directory: `mailbox/dashboard`. `npm ci` requires the
`GITHUB_PACKAGES_TOKEN` env var for @umb-advisors packages — see
`dashboard/.npmrc`. DB-backed tests require `TEST_POSTGRES_URL`; without it
they skip silently.)

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Tests | `npm test` | all pass (DB cases skip without TEST_POSTGRES_URL) |
| Migration syntax | `psql -f migrations/050-*.sql` against a scratch DB, or rely on CI | no error |

## Scope

**In scope**:
- `mailbox/dashboard/migrations/050-add-thread-id-indexes-v1-<date>.sql` (create)
- `mailbox/dashboard/test/fixtures/schema.sql` (add the same two indexes)
- `mailbox/dashboard/lib/queries-thread.ts` (add a batch variant)
- `mailbox/dashboard/lib/queries.ts` (use the batch variant in `listDrafts`)
- `mailbox/dashboard/test/` (new unit test, see Test plan)

**Out of scope**:
- `components/QueueClient.tsx` and the 30s poll interval — response shape must
  not change; the UI is untouched.
- `getDraft` / single-thread callers of `getThreadHistory` — leave them on the
  existing function.
- Any other migration file.

## Git workflow

- Branch: `fix/queue-thread-history-batch`
- Two commits: `feat(db): index inbox_messages/sent_history thread_id` then
  `fix(dashboard): batch thread-history fetch in listDrafts`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Migration adding the two indexes

Create `migrations/050-add-thread-id-indexes-v1-2026-06-11.sql` following the
049 header convention:

```sql
-- Migration 050 — index thread_id on inbox_messages + sent_history.
-- WHAT: two btree indexes used by getThreadHistory / the queue list path.
-- WHY:  every queue render resolves thread history per draft; without these
--       each lookup is a sequential scan on the two largest tables.
CREATE INDEX IF NOT EXISTS inbox_messages_thread_id_idx
  ON mailbox.inbox_messages (thread_id);
CREATE INDEX IF NOT EXISTS sent_history_thread_id_idx
  ON mailbox.sent_history (thread_id);
```

Add the same two `CREATE INDEX IF NOT EXISTS` statements to
`test/fixtures/schema.sql` (append near other index definitions; grep for
`sent_history_sent_at_idx` to find the right region).

**Verify**: `grep -c "thread_id_idx" migrations/050-*.sql test/fixtures/schema.sql` → 2 per file.

### Step 2: Batch variant of getThreadHistory

In `lib/queries-thread.ts`, add `getThreadHistoryBatch(items: Array<{ threadId: string | null; excludeInboxMessageId: number }>): Promise<Map<string, ThreadMessage[]>>`:

- Collect the distinct non-null `threadId`s; if empty, return an empty Map.
- Issue exactly **two** queries total, using `where('thread_id', 'in', ids)`,
  selecting the same columns as the existing per-thread queries **plus
  `thread_id`** (needed to group).
- Reuse the existing row→`ThreadMessage` mapping logic — extract it into small
  pure helpers shared by both functions rather than duplicating it; the
  `excludeInboxMessageId` filter applies per item when assembling each
  draft's list (exclude that message id from the inbound rows of its thread).
- Sort each thread's merged list with the same comparator
  (`a.at.localeCompare(b.at)`).

Keep the existing `getThreadHistory` exported and unchanged in behavior.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Use it in listDrafts

In `lib/queries.ts`, replace the `Promise.all(drafts.map(...))` block
(excerpted above) with one `getThreadHistoryBatch` call over
`drafts.map(d => ({ threadId: d.message.thread_id, excludeInboxMessageId: d.message.id }))`,
then attach `thread_history: map.get(d.message.thread_id) ?? []` per draft.
The returned shape must be identical (drafts with a `thread_history` array,
same ordering).

**Verify**: `npm run typecheck && npm run lint` → exit 0.

## Test plan

- New file `test/lib/queries-thread-batch.test.ts`, modeled structurally on
  `test/routes/auto-send.test.ts` (uses `HAS_DB` gate + `seedDraft` helpers
  from `test/helpers/db.ts`):
  1. Seed two drafts on two different threads with prior inbound + sent rows;
     assert `getThreadHistoryBatch` returns the same per-thread arrays as
     calling `getThreadHistory` per thread (equivalence test — this is the
     regression guard).
  2. Null/empty `threadId` items → `[]` for those drafts, no query errors.
  3. The excluded message id does not appear in its thread's history.
- Verification: `TEST_POSTGRES_URL=... npm test -- queries-thread-batch` → all pass.

## Done criteria

- [ ] `npm run typecheck` and `npm run lint` exit 0
- [ ] Migration 050 exists with both indexes; fixture schema updated
- [ ] `grep -n "Promise.all" mailbox/dashboard/lib/queries.ts` shows no
      per-draft `getThreadHistory` fan-out in `listDrafts`
- [ ] New tests pass under `TEST_POSTGRES_URL` (or are confirmed to gate on `HAS_DB`)
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- `lib/queries.ts` no longer contains the excerpted `Promise.all` block
  (already fixed or refactored).
- The `mailbox` schema name differs from what the migration assumes (check an
  existing migration first, e.g. 049, which writes `mailbox.job_outcomes`).
- The equivalence test (Test plan #1) fails after one fix attempt — report the
  diff between batch and per-thread output instead of forcing it green.
- Migration numbering conflict: a `050-*.sql` already exists.

## Maintenance notes

- If pagination is ever added to `listDrafts`, the batch keys change — keep
  the batch function driven by the page's drafts only.
- Reviewer should scrutinize the `excludeInboxMessageId` per-thread filter:
  two drafts can share a thread; each must exclude only its own message.
- Deferred (out of scope): reducing the 30s poll or deduping in-flight
  client fetches; revisit only if Jetson load is still high after this lands.
