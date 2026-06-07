---
plan_number: 02-02
plan_version: v2
plan_date: 2026-04-27
supersedes: 02-02-schema-foundation-PLAN.md (v1, 2026-04-13)
slug: schema-foundation
wave: 2
depends_on: [02-01]
autonomous: true
requirements: [MAIL-04, MAIL-11, RAG-01, PERS-01, ONBR-01, APPR-01, APPR-02]
files_modified:
  - dashboard/migrations/runner.ts
  - dashboard/migrations/001-extend-drafts-add-status-and-timestamps-v1-2026-04-27.sql
  - dashboard/migrations/002-create-classification-log-v1-2026-04-27.sql
  - dashboard/migrations/003-evolve-drafts-to-queue-shape-v1-2026-04-27.sql
  - dashboard/migrations/004-create-sent-and-rejected-history-v1-2026-04-27.sql
  - dashboard/migrations/005-create-persona-v1-2026-04-27.sql
  - dashboard/migrations/006-create-onboarding-and-seed-v1-2026-04-27.sql
  - dashboard/lib/types.ts
  - dashboard/lib/queries-onboarding.ts
  - dashboard/lib/queries-persona.ts
  - dashboard/package.json
---

<rescope_note>
This plan supersedes v1 (2026-04-13). Two material changes from v1:

1. **Architectural pivot.** The Jetson appliance ships a Next.js 14 full-stack
   dashboard with `app/api/*` routes and hand-rolled `pg` driver queries — not
   the Express + drizzle-orm backend v1 assumed. All `dashboard/backend/src/db/`
   paths in v1 are replaced with raw SQL migrations + `dashboard/lib/` query
   helpers matching the existing pattern (`lib/db.ts`, `lib/queries.ts`,
   `lib/types.ts`).

2. **Existing tables.** v1 was written as if greenfield. The Jetson already has
   `mailbox.inbox_messages` and `mailbox.drafts` (created in Phase 1 dashboard
   sub-project, 2026-04-25). v2 keeps those names and evolves them in place
   instead of creating parallel `email_raw` / `draft_queue` tables. Downstream
   plans 02-03 through 02-08 will reference `inbox_messages` and `drafts`
   instead of `email_raw` and `draft_queue`.

CONTEXT.md decisions D-01, D-04, D-11, D-16, D-17, D-18, D-19, and D-21 are
still implemented literally — the *shape* and *behavior* are preserved, only
the table names and ORM are different.
</rescope_note>

<objective>
Bring the live `mailbox` schema up to the shape Phase 2 needs: extend
`mailbox.drafts` to carry full queue-record provenance (D-17), add
`mailbox.classification_log` for the per-classification audit trail (D-21),
add `mailbox.sent_history` and `mailbox.rejected_history` archival tables
(D-19), and add `mailbox.persona` and `mailbox.onboarding` for voice + state
machine (D-11, D-16). Done via a new versioned SQL migration runner so the
schema can evolve safely going forward without drizzle-kit.

Path: 6 forward-only SQL migrations + a 50-line Node migration runner +
TypeScript types/queries matching the existing hand-rolled pattern.
</objective>

<must_haves>
- A migration runner script (`dashboard/migrations/runner.ts`) that applies
  numbered SQL files in order, tracks applied versions in
  `mailbox.migrations`, and is safely re-runnable (idempotent).
- All migrations apply cleanly against the live Jetson Postgres without
  data loss in `inbox_messages` or `drafts`.
- `mailbox.drafts` after migrations carries every D-17 column:
  `draft_source` (text with CHECK), `classification_category` (text with
  CHECK), `classification_confidence` (numeric), `rag_context_refs` (jsonb),
  `auto_send_blocked` (boolean), `approved_at` (timestamptz), `sent_at`
  (timestamptz), denormalized email fields (`from_addr`, `subject`,
  `body_text`, `received_at`, `message_id`, `thread_id`, `in_reply_to`,
  `references`).
- `mailbox.drafts.status` CHECK extended to include `awaiting_cloud` (D-03).
- `mailbox.classification_log` exists with one row per classification
  attempt, including spam/marketing drops (D-21) — references
  `inbox_messages.id` via FK.
- `mailbox.sent_history` and `mailbox.rejected_history` exist, ready to
  receive archived rows (write triggers come in plans 02-07 and 02-08).
- `mailbox.persona` exists with single-row-per-customer shape, jsonb
  `statistical_markers` and `category_exemplars`.
- `mailbox.onboarding` exists with text `stage` column constrained to the
  6 D-16 values via CHECK, and is seeded with one `pending_admin` row.
- `dashboard/lib/types.ts` exports TypeScript interfaces for every new
  table, in the same flat-interface style as existing `Draft` and
  `InboxMessage` types.
- `dashboard/lib/queries-onboarding.ts` and `queries-persona.ts` exist
  with parameterized SQL queries following the `lib/queries.ts` pattern.
</must_haves>

<threat_model>
**ASVS L1, block on HIGH.** Phase 2 LAN-trust boundary applies; auth comes Phase 4.

| Surface | Threat | Mitigation | Severity |
|---------|--------|------------|----------|
| Migration runner running twice | Duplicate ALTER TABLE → error or duplicate columns | `mailbox.migrations` tracking table; runner skips already-applied versions; every migration uses `IF NOT EXISTS` / `IF NOT EXISTS COLUMN` where possible | Medium → mitigated |
| Backfill of denormalized columns from `inbox_messages` JOIN | Inconsistent state if run twice | Backfill is `UPDATE ... WHERE column IS NULL` so re-runs are no-ops | Low → mitigated |
| `inbox_messages.classification` already populated, copying to `classification_log` | Loss of historical data on rollback | This is forward-only; no rollback path. Dashboard sub-project's existing rows are backfilled into `classification_log` once. The original `inbox_messages.classification` column is **left in place** (not dropped) so existing `lib/queries.ts` continues to work | Medium → mitigated by non-destructive approach |
| jsonb default expression on `rag_context_refs` | NULL vs `'[]'` ambiguity in queries | Column defaults to `'[]'::jsonb` and is NOT NULL. Inserts that don't specify it get the empty array | Low → mitigated |
| New `onboarding` row created twice | Duplicate state machines | UNIQUE constraint on `customer_key`; INSERT uses ON CONFLICT DO NOTHING | Low → mitigated |
| Postgres user `mailbox` lacks DDL privileges | Migration fails partway | Phase 1 already grants the `mailbox` user CREATE on the `mailbox` schema (verified in 01-01). No additional grants needed | Low → already mitigated |
</threat_model>

<tasks>

<task id="1">
<action>
Create the migration runner. This is a tiny Node script that:
- Connects via `POSTGRES_URL` (already in dashboard env)
- Ensures `mailbox.migrations` tracking table exists
- Reads `dashboard/migrations/*.sql` in lexical order
- For each file, checks `mailbox.migrations.version` for a match; if absent,
  applies it inside a transaction and records the version + applied_at
- Logs each step; non-zero exit on any failure

Create `dashboard/migrations/runner.ts`:

```ts
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL not set');

  const client = new Client({ connectionString: url });
  await client.connect();

  await client.query(`
    CREATE SCHEMA IF NOT EXISTS mailbox;
    CREATE TABLE IF NOT EXISTS mailbox.migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const files = (await readdir(here))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const f of files) {
    const version = f.replace(/\.sql$/, '');
    const { rows } = await client.query(
      'SELECT 1 FROM mailbox.migrations WHERE version = $1',
      [version],
    );
    if (rows.length > 0) {
      console.log(`[skip] ${version} (already applied)`);
      continue;
    }
    const sql = await readFile(join(here, f), 'utf8');
    console.log(`[apply] ${version}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO mailbox.migrations (version) VALUES ($1)',
        [version],
      );
      await client.query('COMMIT');
      console.log(`[ok]    ${version}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[fail]  ${version}`);
      throw err;
    }
  }

  await client.end();
  console.log('migrations complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Add an npm script in `dashboard/package.json`:

```json
"scripts": {
  "...": "...",
  "migrate": "tsx migrations/runner.ts"
}
```

(Keep all existing scripts; just add `migrate`.)

Add `tsx` as a dev dependency if not already present:

```bash
ssh mailbox1 'cd ~/mailbox/dashboard && npm install --save-dev tsx'
```
</action>
<read_first>
- dashboard/lib/db.ts (existing pg.Pool pattern — runner uses Client instead since it's one-shot)
- dashboard/package.json (current scripts)
- dashboard/Dockerfile (Node 20 alpine; tsx works there)
</read_first>
<acceptance_criteria>
- `dashboard/migrations/runner.ts` exists
- `grep 'CREATE TABLE IF NOT EXISTS mailbox.migrations' dashboard/migrations/runner.ts` matches
- `grep 'mailbox.migrations.version' dashboard/migrations/runner.ts` matches one query
- `grep '"migrate":' dashboard/package.json` matches
- `ls dashboard/node_modules/tsx >/dev/null` exits 0
</acceptance_criteria>
</task>

<task id="2">
<action>
Create migration `001-extend-drafts-add-status-and-timestamps-v1-2026-04-27.sql`.

Adds the `awaiting_cloud` status to the `drafts` CHECK constraint (D-03)
and adds `approved_at` / `sent_at` columns. These are the bare-minimum
extensions that the queue API and 02-08 onboarding plan reference; they
are split out as the first migration so we can apply them with low risk
before the larger `drafts` evolution in migration 003.

```sql
-- 001-extend-drafts-add-status-and-timestamps-v1-2026-04-27.sql
-- Adds awaiting_cloud status (D-03) and approval/send timestamps to drafts.

ALTER TABLE mailbox.drafts
  DROP CONSTRAINT IF EXISTS drafts_status_check;

ALTER TABLE mailbox.drafts
  ADD CONSTRAINT drafts_status_check
  CHECK (status = ANY (ARRAY[
    'pending',
    'awaiting_cloud',
    'approved',
    'rejected',
    'edited',
    'sent',
    'failed'
  ]));

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
```
</action>
<read_first>
- (live schema) docker compose exec postgres psql ... '\d+ mailbox.drafts'
  (current CHECK list, current column set)
</read_first>
<acceptance_criteria>
- File exists at `dashboard/migrations/001-extend-drafts-add-status-and-timestamps-v1-2026-04-27.sql`
- `grep 'awaiting_cloud' dashboard/migrations/001-*.sql` matches
- `grep 'approved_at' dashboard/migrations/001-*.sql` matches
- `grep 'sent_at' dashboard/migrations/001-*.sql` matches
- After running migration: `\d mailbox.drafts` shows `approved_at` and `sent_at`
- After running migration: drafts CHECK includes `awaiting_cloud`
</acceptance_criteria>
</task>

<task id="3">
<action>
Create migration `002-create-classification-log-v1-2026-04-27.sql`.

Creates the per-classification audit log (D-21) and backfills it from the
existing classification fields on `inbox_messages`. The backfill is a
one-shot UPDATE-IF-EMPTY so re-runs are no-ops.

The original `inbox_messages.classification` / `confidence` / `classified_at`
/ `model` columns are LEFT IN PLACE — existing `lib/queries.ts` JSON
projections still work. Future writes go to both places (workflow handles
that in plan 02-04).

```sql
-- 002-create-classification-log-v1-2026-04-27.sql
-- Per-classification audit log (D-21). Spam/marketing drops also land here.

CREATE TABLE IF NOT EXISTS mailbox.classification_log (
  id              BIGSERIAL PRIMARY KEY,
  inbox_message_id INTEGER NOT NULL
    REFERENCES mailbox.inbox_messages(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  confidence      REAL NOT NULL,
  model_version   TEXT NOT NULL,
  latency_ms      INTEGER,
  raw_output      TEXT,
  json_parse_ok   BOOLEAN NOT NULL,
  think_stripped  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT classification_log_category_check CHECK (category = ANY (ARRAY[
    'inquiry','reorder','scheduling','follow_up',
    'internal','spam_marketing','escalate','unknown'
  ]))
);

CREATE INDEX IF NOT EXISTS classification_log_message_idx
  ON mailbox.classification_log(inbox_message_id);
CREATE INDEX IF NOT EXISTS classification_log_category_idx
  ON mailbox.classification_log(category);

-- Backfill from existing inbox_messages rows that have classification data.
-- Only inserts where there is no existing classification_log row for the message.
INSERT INTO mailbox.classification_log
  (inbox_message_id, category, confidence, model_version,
   json_parse_ok, think_stripped, created_at)
SELECT
  m.id,
  COALESCE(m.classification, 'unknown')               AS category,
  COALESCE(m.confidence, 0)::real                     AS confidence,
  COALESCE(m.model, 'backfill-unknown')               AS model_version,
  TRUE                                                AS json_parse_ok,
  FALSE                                               AS think_stripped,
  COALESCE(m.classified_at, m.created_at, NOW())      AS created_at
FROM mailbox.inbox_messages m
WHERE m.classification IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM mailbox.classification_log cl
    WHERE cl.inbox_message_id = m.id
  );
```

Categories from MAIL-05 are: `inquiry, reorder, scheduling, follow_up,
internal, spam_marketing, escalate, unknown`. The CHECK matches the v1
plan's `pgEnum` shape semantically while staying in plain SQL.
</action>
<read_first>
- (live schema) inbox_messages columns
- .planning/phases/02-email-pipeline-core/02-CONTEXT.md (D-21)
- .planning/REQUIREMENTS.md (MAIL-05 8-category list)
</read_first>
<acceptance_criteria>
- File exists at `dashboard/migrations/002-create-classification-log-v1-2026-04-27.sql`
- After running: `\d mailbox.classification_log` shows the table
- After running: `SELECT COUNT(*) FROM mailbox.classification_log` >= count of inbox_messages with non-null classification
- Re-running the migration is a no-op (skipped by runner via tracking table)
- CHECK on category includes all 8 MAIL-05 values
</acceptance_criteria>
</task>

<task id="4">
<action>
Create migration `003-evolve-drafts-to-queue-shape-v1-2026-04-27.sql`.

Adds the missing D-17 columns to `mailbox.drafts` and backfills them from
`inbox_messages` for existing rows. Existing `drafts` rows are preserved
with sensible defaults; new rows from plan 02-04+ will populate everything.

```sql
-- 003-evolve-drafts-to-queue-shape-v1-2026-04-27.sql
-- Brings mailbox.drafts up to D-17 queue-record shape.

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS draft_source TEXT,
  ADD COLUMN IF NOT EXISTS classification_category TEXT,
  ADD COLUMN IF NOT EXISTS classification_confidence REAL,
  ADD COLUMN IF NOT EXISTS rag_context_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS auto_send_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS from_addr TEXT,
  ADD COLUMN IF NOT EXISTS to_addr TEXT,
  ADD COLUMN IF NOT EXISTS subject TEXT,
  ADD COLUMN IF NOT EXISTS body_text TEXT,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS message_id TEXT,
  ADD COLUMN IF NOT EXISTS thread_id TEXT,
  ADD COLUMN IF NOT EXISTS in_reply_to TEXT,
  ADD COLUMN IF NOT EXISTS "references" TEXT;

-- Constrain draft_source values (D-17). Nullable until classification fires.
ALTER TABLE mailbox.drafts
  DROP CONSTRAINT IF EXISTS drafts_draft_source_check;
ALTER TABLE mailbox.drafts
  ADD CONSTRAINT drafts_draft_source_check
  CHECK (draft_source IS NULL OR draft_source = ANY (ARRAY[
    'local_qwen3','cloud_haiku'
  ]));

-- Constrain classification_category to the same MAIL-05 list.
ALTER TABLE mailbox.drafts
  DROP CONSTRAINT IF EXISTS drafts_classification_category_check;
ALTER TABLE mailbox.drafts
  ADD CONSTRAINT drafts_classification_category_check
  CHECK (classification_category IS NULL OR classification_category = ANY (ARRAY[
    'inquiry','reorder','scheduling','follow_up',
    'internal','spam_marketing','escalate','unknown'
  ]));

-- Hot-path indexes for the queue API.
CREATE INDEX IF NOT EXISTS drafts_received_at_idx
  ON mailbox.drafts(received_at DESC);
CREATE INDEX IF NOT EXISTS drafts_category_idx
  ON mailbox.drafts(classification_category);
CREATE INDEX IF NOT EXISTS drafts_rag_refs_gin
  ON mailbox.drafts USING gin(rag_context_refs);

-- Backfill denormalized fields from inbox_messages where missing.
UPDATE mailbox.drafts d
   SET from_addr   = COALESCE(d.from_addr,   m.from_addr),
       to_addr     = COALESCE(d.to_addr,     m.to_addr),
       subject     = COALESCE(d.subject,     m.subject),
       body_text   = COALESCE(d.body_text,   m.body),
       received_at = COALESCE(d.received_at, m.received_at),
       message_id  = COALESCE(d.message_id,  m.message_id),
       thread_id   = COALESCE(d.thread_id,   m.thread_id),
       classification_category   = COALESCE(d.classification_category,
                                            m.classification),
       classification_confidence = COALESCE(d.classification_confidence,
                                            m.confidence::real)
  FROM mailbox.inbox_messages m
 WHERE d.inbox_message_id = m.id
   AND (d.from_addr IS NULL
        OR d.received_at IS NULL
        OR d.classification_category IS NULL);
```
</action>
<read_first>
- (live schema) full \d+ mailbox.drafts and \d+ mailbox.inbox_messages
- .planning/phases/02-email-pipeline-core/02-CONTEXT.md (D-04, D-17)
</read_first>
<acceptance_criteria>
- File exists at `dashboard/migrations/003-evolve-drafts-to-queue-shape-v1-2026-04-27.sql`
- After running: `\d mailbox.drafts` shows new columns: `draft_source`,
  `classification_category`, `classification_confidence`, `rag_context_refs`,
  `auto_send_blocked`, `from_addr`, `to_addr`, `subject`, `body_text`,
  `received_at`, `message_id`, `thread_id`, `in_reply_to`, `references`
- After running: `\di mailbox.drafts*` shows `drafts_received_at_idx`,
  `drafts_category_idx`, `drafts_rag_refs_gin`
- After running: existing `drafts` rows have backfilled `from_addr`,
  `received_at`, `classification_category` (verify with a SELECT that
  COUNT(rows where from_addr IS NULL AND inbox_message_id IS NOT NULL) = 0)
- After running: `lib/queries.ts` LIST_DRAFTS_SQL still returns rows
  successfully (the existing `d.*` projection now includes the new columns,
  but the JSON build_object in the query is unchanged so wire shape is
  backward compatible)
</acceptance_criteria>
</task>

<task id="5">
<action>
Create migration `004-create-sent-and-rejected-history-v1-2026-04-27.sql`.

Archival tables for D-19. Empty after migration; populated by the workflow
plans (02-07 send-smtp-sub on approve; 02-08 reject-sub on reject).

```sql
-- 004-create-sent-and-rejected-history-v1-2026-04-27.sql
-- Archival targets (D-19): on approve→sent_history; on reject→rejected_history.

CREATE TABLE IF NOT EXISTS mailbox.sent_history (
  id                        BIGSERIAL PRIMARY KEY,
  draft_id                  INTEGER NOT NULL,           -- original drafts.id for audit
  inbox_message_id          INTEGER NOT NULL,
  from_addr                 TEXT    NOT NULL,
  to_addr                   TEXT    NOT NULL,
  subject                   TEXT,
  body_text                 TEXT,
  thread_id                 TEXT,
  draft_original            TEXT,
  draft_sent                TEXT    NOT NULL,
  draft_source              TEXT    NOT NULL,
  classification_category   TEXT    NOT NULL,
  classification_confidence REAL    NOT NULL,
  rag_context_refs          JSONB   NOT NULL DEFAULT '[]'::jsonb,
  sent_at                   TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sent_history_draft_source_check
    CHECK (draft_source = ANY (ARRAY['local_qwen3','cloud_haiku'])),
  CONSTRAINT sent_history_category_check
    CHECK (classification_category = ANY (ARRAY[
      'inquiry','reorder','scheduling','follow_up',
      'internal','spam_marketing','escalate','unknown'
    ]))
);

CREATE INDEX IF NOT EXISTS sent_history_sent_at_idx
  ON mailbox.sent_history(sent_at DESC);
CREATE INDEX IF NOT EXISTS sent_history_category_idx
  ON mailbox.sent_history(classification_category);

CREATE TABLE IF NOT EXISTS mailbox.rejected_history (
  id                        BIGSERIAL PRIMARY KEY,
  draft_id                  INTEGER NOT NULL,
  inbox_message_id          INTEGER NOT NULL,
  from_addr                 TEXT    NOT NULL,
  subject                   TEXT,
  classification_category   TEXT    NOT NULL,
  classification_confidence REAL    NOT NULL,
  draft_original            TEXT,
  rejected_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rejected_history_category_check
    CHECK (classification_category = ANY (ARRAY[
      'inquiry','reorder','scheduling','follow_up',
      'internal','spam_marketing','escalate','unknown'
    ]))
);

CREATE INDEX IF NOT EXISTS rejected_history_rejected_at_idx
  ON mailbox.rejected_history(rejected_at DESC);
```

No FKs back to `mailbox.drafts.id` because rows are written here at the
moment the originating draft row is deleted (D-19 archival semantics).
The integer column preserves audit trail without enforcing referential
integrity that would block the move.
</action>
<read_first>
- .planning/phases/02-email-pipeline-core/02-CONTEXT.md (D-19, D-21)
</read_first>
<acceptance_criteria>
- File exists at `dashboard/migrations/004-create-sent-and-rejected-history-v1-2026-04-27.sql`
- After running: `\dt mailbox.*` shows both `sent_history` and `rejected_history`
- After running: indexes exist (`\di mailbox.sent_history_*` and
  `\di mailbox.rejected_history_*`)
- Both tables empty after first run (`SELECT COUNT(*) = 0`)
</acceptance_criteria>
</task>

<task id="6">
<action>
Create migration `005-create-persona-v1-2026-04-27.sql`.

Single-row-per-customer persona table (D-11).

```sql
-- 005-create-persona-v1-2026-04-27.sql
-- Voice profile (D-11): one row per customer_key.

CREATE TABLE IF NOT EXISTS mailbox.persona (
  id                  SERIAL PRIMARY KEY,
  customer_key        TEXT NOT NULL DEFAULT 'default',
  statistical_markers JSONB NOT NULL DEFAULT '{}'::jsonb,
  category_exemplars  JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_email_count  INTEGER NOT NULL DEFAULT 0,
  last_refreshed_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS persona_customer_key_uq
  ON mailbox.persona(customer_key);
```
</action>
<read_first>
- .planning/phases/02-email-pipeline-core/02-CONTEXT.md (D-07..D-11)
</read_first>
<acceptance_criteria>
- File exists at `dashboard/migrations/005-create-persona-v1-2026-04-27.sql`
- After running: `\d mailbox.persona` shows the table
- Unique index `persona_customer_key_uq` present
- jsonb defaults: `SELECT statistical_markers, category_exemplars FROM
  mailbox.persona` would return `{}` and `{}` if a row existed
</acceptance_criteria>
</task>

<task id="7">
<action>
Create migration `006-create-onboarding-and-seed-v1-2026-04-27.sql`.

Onboarding state machine (D-16) + seed the initial `pending_admin` row so
the live gate has something to read in plan 02-08.

```sql
-- 006-create-onboarding-and-seed-v1-2026-04-27.sql
-- Onboarding state machine (D-16). 6 stages enforced via CHECK.

CREATE TABLE IF NOT EXISTS mailbox.onboarding (
  id                     SERIAL PRIMARY KEY,
  customer_key           TEXT NOT NULL DEFAULT 'default',
  stage                  TEXT NOT NULL DEFAULT 'pending_admin',
  admin_username         TEXT,
  admin_password_hash    TEXT,
  email_address          TEXT,
  ingest_progress_total  INTEGER,
  ingest_progress_done   INTEGER NOT NULL DEFAULT 0,
  tuning_sample_count    INTEGER NOT NULL DEFAULT 0,
  tuning_rated_count     INTEGER NOT NULL DEFAULT 0,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lived_at               TIMESTAMPTZ,
  CONSTRAINT onboarding_stage_check CHECK (stage = ANY (ARRAY[
    'pending_admin',
    'pending_email',
    'ingesting',
    'pending_tuning',
    'tuning_in_progress',
    'live'
  ]))
);

CREATE UNIQUE INDEX IF NOT EXISTS onboarding_customer_key_uq
  ON mailbox.onboarding(customer_key);
CREATE INDEX IF NOT EXISTS onboarding_stage_idx
  ON mailbox.onboarding(stage);

-- Seed the single-tenant default row. ON CONFLICT keeps re-runs idempotent.
INSERT INTO mailbox.onboarding (customer_key, stage)
VALUES ('default', 'pending_admin')
ON CONFLICT (customer_key) DO NOTHING;
```
</action>
<read_first>
- .planning/phases/02-email-pipeline-core/02-CONTEXT.md (D-12..D-16)
- .planning/REQUIREMENTS.md (ONBR-01..06)
</read_first>
<acceptance_criteria>
- File exists at `dashboard/migrations/006-create-onboarding-and-seed-v1-2026-04-27.sql`
- After running: `\d mailbox.onboarding` shows the table with stage CHECK
- After running: `SELECT stage FROM mailbox.onboarding WHERE customer_key='default'`
  returns `pending_admin`
- All 6 D-16 stages are present in the CHECK clause
- Re-running the migration leaves the seed row unchanged (no duplicate row;
  no error)
</acceptance_criteria>
</task>

<task id="8">
<action>
Extend `dashboard/lib/types.ts` with TypeScript interfaces for every new
table, matching the existing flat-interface style. Do **not** modify the
existing `Draft`, `InboxMessage`, `DraftWithMessage`, or `DraftStatus`
types (used by working code).

Append to `dashboard/lib/types.ts`:

```ts
// ── Phase 2 additions (plan 02-02 v2) ───────────────────────────────────

export type ClassificationCategory =
  | 'inquiry'
  | 'reorder'
  | 'scheduling'
  | 'follow_up'
  | 'internal'
  | 'spam_marketing'
  | 'escalate'
  | 'unknown';

export type DraftSource = 'local_qwen3' | 'cloud_haiku';

// Extended DraftStatus for awaiting_cloud (D-03)
export type DraftStatusV2 =
  | DraftStatus
  | 'awaiting_cloud';

export interface ClassificationLog {
  id: number;
  inbox_message_id: number;
  category: ClassificationCategory;
  confidence: string;       // pg returns REAL as string for parity
  model_version: string;
  latency_ms: number | null;
  raw_output: string | null;
  json_parse_ok: boolean;
  think_stripped: boolean;
  created_at: string;
}

export interface SentHistory {
  id: number;
  draft_id: number;
  inbox_message_id: number;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  body_text: string | null;
  thread_id: string | null;
  draft_original: string | null;
  draft_sent: string;
  draft_source: DraftSource;
  classification_category: ClassificationCategory;
  classification_confidence: string;
  rag_context_refs: unknown[];   // JSONB array of {chunkId, score, source}
  sent_at: string;
  created_at: string;
}

export interface RejectedHistory {
  id: number;
  draft_id: number;
  inbox_message_id: number;
  from_addr: string;
  subject: string | null;
  classification_category: ClassificationCategory;
  classification_confidence: string;
  draft_original: string | null;
  rejected_at: string;
  created_at: string;
}

export interface Persona {
  id: number;
  customer_key: string;
  statistical_markers: Record<string, unknown>;
  category_exemplars: Record<string, unknown>;
  source_email_count: number;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type OnboardingStage =
  | 'pending_admin'
  | 'pending_email'
  | 'ingesting'
  | 'pending_tuning'
  | 'tuning_in_progress'
  | 'live';

export interface Onboarding {
  id: number;
  customer_key: string;
  stage: OnboardingStage;
  admin_username: string | null;
  admin_password_hash: string | null;
  email_address: string | null;
  ingest_progress_total: number | null;
  ingest_progress_done: number;
  tuning_sample_count: number;
  tuning_rated_count: number;
  started_at: string;
  lived_at: string | null;
}
```
</action>
<read_first>
- dashboard/lib/types.ts (existing types — do not break)
- .planning/phases/02-email-pipeline-core/02-CONTEXT.md (column shapes)
</read_first>
<acceptance_criteria>
- `grep 'export type ClassificationCategory' dashboard/lib/types.ts` matches
- `grep 'export type DraftSource' dashboard/lib/types.ts` matches
- `grep 'export interface ClassificationLog' dashboard/lib/types.ts` matches
- `grep 'export interface Onboarding' dashboard/lib/types.ts` matches
- `grep 'export type OnboardingStage' dashboard/lib/types.ts` matches
- `grep 'export interface Draft ' dashboard/lib/types.ts` STILL matches
  (existing type preserved)
- `npx tsc --noEmit` (or `npm run typecheck` per package.json) exits 0
</acceptance_criteria>
</task>

<task id="9">
<action>
Create `dashboard/lib/queries-onboarding.ts` and
`dashboard/lib/queries-persona.ts` with the parameterized SQL queries plan
02-08 will need. Pattern matches `lib/queries.ts` exactly: top-of-file SQL
constants, typed wrapper functions using the shared `getPool()`.

`dashboard/lib/queries-onboarding.ts`:

```ts
import { getPool } from '@/lib/db';
import type { Onboarding, OnboardingStage } from '@/lib/types';

const GET_ONBOARDING_SQL = `
  SELECT * FROM mailbox.onboarding WHERE customer_key = $1
`;

const UPDATE_ONBOARDING_STAGE_SQL = `
  UPDATE mailbox.onboarding
     SET stage = $2,
         lived_at = CASE WHEN $2 = 'live' THEN NOW() ELSE lived_at END
   WHERE customer_key = $1
   RETURNING *
`;

const UPDATE_ADMIN_SQL = `
  UPDATE mailbox.onboarding
     SET admin_username = $2,
         admin_password_hash = $3,
         stage = 'pending_email'
   WHERE customer_key = $1
   RETURNING *
`;

const UPDATE_EMAIL_SQL = `
  UPDATE mailbox.onboarding
     SET email_address = $2,
         stage = 'ingesting'
   WHERE customer_key = $1
   RETURNING *
`;

export async function getOnboarding(
  customerKey = 'default',
): Promise<Onboarding | null> {
  const pool = getPool();
  const r = await pool.query<Onboarding>(GET_ONBOARDING_SQL, [customerKey]);
  return r.rows[0] ?? null;
}

export async function setStage(
  stage: OnboardingStage,
  customerKey = 'default',
): Promise<Onboarding | null> {
  const pool = getPool();
  const r = await pool.query<Onboarding>(
    UPDATE_ONBOARDING_STAGE_SQL,
    [customerKey, stage],
  );
  return r.rows[0] ?? null;
}

export async function setAdmin(
  username: string,
  passwordHash: string,
  customerKey = 'default',
): Promise<Onboarding | null> {
  const pool = getPool();
  const r = await pool.query<Onboarding>(
    UPDATE_ADMIN_SQL,
    [customerKey, username, passwordHash],
  );
  return r.rows[0] ?? null;
}

export async function setEmail(
  email: string,
  customerKey = 'default',
): Promise<Onboarding | null> {
  const pool = getPool();
  const r = await pool.query<Onboarding>(
    UPDATE_EMAIL_SQL,
    [customerKey, email],
  );
  return r.rows[0] ?? null;
}

export async function isLive(customerKey = 'default'): Promise<boolean> {
  const row = await getOnboarding(customerKey);
  return row?.stage === 'live';
}
```

`dashboard/lib/queries-persona.ts`:

```ts
import { getPool } from '@/lib/db';
import type { Persona } from '@/lib/types';

const GET_PERSONA_SQL = `
  SELECT * FROM mailbox.persona WHERE customer_key = $1
`;

const UPSERT_PERSONA_SQL = `
  INSERT INTO mailbox.persona
    (customer_key, statistical_markers, category_exemplars,
     source_email_count, last_refreshed_at, updated_at)
  VALUES ($1, $2, $3, $4, NOW(), NOW())
  ON CONFLICT (customer_key) DO UPDATE
    SET statistical_markers = EXCLUDED.statistical_markers,
        category_exemplars  = EXCLUDED.category_exemplars,
        source_email_count  = EXCLUDED.source_email_count,
        last_refreshed_at   = EXCLUDED.last_refreshed_at,
        updated_at          = NOW()
  RETURNING *
`;

export async function getPersona(
  customerKey = 'default',
): Promise<Persona | null> {
  const pool = getPool();
  const r = await pool.query<Persona>(GET_PERSONA_SQL, [customerKey]);
  return r.rows[0] ?? null;
}

export async function upsertPersona(
  statistical: Record<string, unknown>,
  exemplars: Record<string, unknown>,
  sourceCount: number,
  customerKey = 'default',
): Promise<Persona> {
  const pool = getPool();
  const r = await pool.query<Persona>(UPSERT_PERSONA_SQL, [
    customerKey,
    JSON.stringify(statistical),
    JSON.stringify(exemplars),
    sourceCount,
  ]);
  return r.rows[0];
}
```
</action>
<read_first>
- dashboard/lib/queries.ts (pattern to mirror exactly)
- dashboard/lib/db.ts
- dashboard/lib/types.ts (after task 8)
</read_first>
<acceptance_criteria>
- `dashboard/lib/queries-onboarding.ts` exists
- `dashboard/lib/queries-persona.ts` exists
- `grep 'getOnboarding' dashboard/lib/queries-onboarding.ts` matches
- `grep 'setAdmin' dashboard/lib/queries-onboarding.ts` matches
- `grep 'isLive' dashboard/lib/queries-onboarding.ts` matches
- `grep 'upsertPersona' dashboard/lib/queries-persona.ts` matches
- `grep 'getPool' dashboard/lib/queries-onboarding.ts` matches (uses shared pool)
- `grep "stage === 'live'" dashboard/lib/queries-onboarding.ts` matches
- `npm run typecheck` exits 0 from dashboard/
</acceptance_criteria>
</task>

<task id="10">
<action>
Apply all migrations on the live Jetson and verify.

```bash
# from the workstation (or directly on the Jetson)
ssh mailbox1 'cd ~/mailbox && git pull'
ssh mailbox1 'cd ~/mailbox && docker compose build dashboard'
ssh mailbox1 'cd ~/mailbox && docker compose up -d dashboard'

# Run the migration runner inside the container so it has POSTGRES_URL.
ssh mailbox1 'cd ~/mailbox && docker compose exec -T mailbox-dashboard npm run migrate'

# Verify
ssh mailbox1 "cd ~/mailbox && docker compose exec -T postgres psql -U mailbox -d mailbox -Atc \
  \"SELECT version FROM mailbox.migrations ORDER BY version;\""

ssh mailbox1 "cd ~/mailbox && docker compose exec -T postgres psql -U mailbox -d mailbox -Atc \
  \"SELECT count(*) FROM information_schema.tables WHERE table_schema='mailbox';\""

ssh mailbox1 "cd ~/mailbox && docker compose exec -T postgres psql -U mailbox -d mailbox -Atc \
  \"SELECT stage FROM mailbox.onboarding WHERE customer_key='default';\""
```
</action>
<read_first>
- All migration files
- dashboard/migrations/runner.ts
</read_first>
<acceptance_criteria>
- `npm run migrate` exits 0
- `mailbox.migrations` lists all 6 migration versions
- `count(*)` from `information_schema.tables WHERE table_schema='mailbox'`
  returns 7 (inbox_messages, drafts, classification_log, sent_history,
  rejected_history, persona, onboarding) plus `migrations` = 8
- `mailbox.onboarding` seed row has `stage='pending_admin'`
- Existing dashboard endpoints still work — sanity check:
  `curl -fsS https://mailbox.heronlabsinc.com/dashboard/api/drafts | jq -e '.[0].id'`
  returns a valid id (existing rows still readable through the dashboard)
- Re-running `npm run migrate` immediately after is a no-op:
  every line in stdout starts with `[skip]` and exits 0
</acceptance_criteria>
</task>

</tasks>

<verification>
```bash
# 1. All 7 mailbox tables present (8 with migrations)
ssh mailbox1 "cd ~/mailbox && docker compose exec -T postgres psql -U mailbox -d mailbox -Atc \
  \"SELECT table_name FROM information_schema.tables
    WHERE table_schema='mailbox' ORDER BY table_name;\"" \
  | sort | tr '\n' ' '
# Expected: classification_log drafts inbox_messages migrations onboarding persona rejected_history sent_history

# 2. drafts has D-17 columns
ssh mailbox1 "cd ~/mailbox && docker compose exec -T postgres psql -U mailbox -d mailbox -Atc \
  \"SELECT column_name FROM information_schema.columns
    WHERE table_schema='mailbox' AND table_name='drafts'
    ORDER BY ordinal_position;\""
# Must include: draft_source, classification_category, classification_confidence,
# rag_context_refs, auto_send_blocked, approved_at, sent_at, from_addr,
# to_addr, subject, body_text, received_at, message_id, thread_id,
# in_reply_to, references

# 3. drafts CHECKs include awaiting_cloud and the right MAIL-05 categories
ssh mailbox1 "cd ~/mailbox && docker compose exec -T postgres psql -U mailbox -d mailbox -Atc \
  \"SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid='mailbox.drafts'::regclass
    AND conname IN ('drafts_status_check','drafts_draft_source_check','drafts_classification_category_check');\""

# 4. onboarding stages match D-16 exactly
ssh mailbox1 "cd ~/mailbox && docker compose exec -T postgres psql -U mailbox -d mailbox -Atc \
  \"SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid='mailbox.onboarding'::regclass
    AND conname='onboarding_stage_check';\""
# Must include all 6: pending_admin, pending_email, ingesting,
# pending_tuning, tuning_in_progress, live

# 5. drafts GIN index on rag_context_refs exists
ssh mailbox1 "cd ~/mailbox && docker compose exec -T postgres psql -U mailbox -d mailbox -Atc \
  \"SELECT indexname FROM pg_indexes
    WHERE schemaname='mailbox' AND tablename='drafts'
    AND indexname='drafts_rag_refs_gin';\""

# 6. Backfill from inbox_messages worked
ssh mailbox1 "cd ~/mailbox && docker compose exec -T postgres psql -U mailbox -d mailbox -Atc \
  \"SELECT
       (SELECT count(*) FROM mailbox.inbox_messages WHERE classification IS NOT NULL) AS msgs_classified,
       (SELECT count(*) FROM mailbox.classification_log) AS log_rows;\""
# log_rows >= msgs_classified

# 7. Existing dashboard queue still functional
ssh mailbox1 'curl -fsS http://localhost/dashboard/api/drafts | jq "length"'
# Returns a number (no 500)

# 8. Migration runner is idempotent
ssh mailbox1 'cd ~/mailbox && docker compose exec -T mailbox-dashboard npm run migrate 2>&1' | grep -c '\[skip\]'
# Returns 6 (one per migration)
```
</verification>
