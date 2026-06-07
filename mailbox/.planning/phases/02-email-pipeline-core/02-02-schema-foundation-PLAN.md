---
status: SUPERSEDED
superseded_by: 02-02-schema-foundation-PLAN-v2-2026-04-27.md
supersession_date: 2026-04-27
supersession_reason: 2026-04-27 Next.js full-stack ADR retired the Express backend layout (`dashboard/backend/src/...`) this plan targets in favor of `dashboard/app/api/...` route handlers and `dashboard/lib/...` modules. v2 plan shipped 6 forward-only SQL migrations against a new migration runner instead of `drizzle-kit push`. See ADR in `.planning/STATE.md` "Architectural Decision Record: Dashboard Stack Pivot".
plan_number: 02-02
slug: schema-foundation
wave: 2
depends_on: [02-01]
autonomous: true
requirements: [MAIL-11, RAG-01, PERS-01, ONBR-01, APPR-01, APPR-02]
files_modified:
  - dashboard/backend/src/db/schema.ts
  - dashboard/backend/src/db/types.ts
  - dashboard/backend/src/db/enums.ts
---

<objective>
Define the drizzle-orm schema for the seven Phase 2 tables inside the existing `mailbox` Postgres schema, then push the schema to the live database. This plan creates the durable shape of every email, draft, classification, persona record, and onboarding state the rest of Phase 2 depends on. CONTEXT.md decisions D-01, D-04, D-11, D-16, D-17, D-18, D-19, and D-21 are implemented here literally.
</objective>

<must_haves>
- All seven tables exist in `mailbox.*` after the plan runs:
  `email_raw`, `classification_log`, `draft_queue`, `sent_history`, `rejected_history`, `persona`, `onboarding`
- `draft_queue` has columns matching D-17 exactly (including `draft_source`, `rag_context_refs JSONB`, `auto_send_blocked BOOLEAN`, `classification_category`, `classification_confidence`)
- `persona` has a single-row-per-customer shape with JSONB `statistical_markers` and JSONB `category_exemplars`
- `onboarding` has an enum `stage` column restricted to the 6 D-16 values
- Indexes exist for the approval queue hot path (`status`, `received_at DESC`, `classification_category`)
- `drizzle-kit push` runs non-interactively and the live Postgres reflects the schema
</must_haves>

<tasks>

<task id="1">
<action>
Create `dashboard/backend/src/db/enums.ts` with Postgres enum type declarations drizzle will emit. The 6 onboarding stages come from CONTEXT.md D-16; the 8 classification categories come from MAIL-05; the draft-queue status values come from D-17 and D-03; the draft source values come from D-17:

```ts
import { pgEnum } from 'drizzle-orm/pg-core';

export const onboardingStageEnum = pgEnum('onboarding_stage', [
  'pending_admin',
  'pending_email',
  'ingesting',
  'pending_tuning',
  'tuning_in_progress',
  'live',
]);

export const classificationCategoryEnum = pgEnum('classification_category', [
  'inquiry',
  'reorder',
  'scheduling',
  'follow_up',
  'internal',
  'spam_marketing',
  'escalate',
  'unknown',
]);

export const draftQueueStatusEnum = pgEnum('draft_queue_status', [
  'pending_review',
  'awaiting_cloud',
  'approved',
  'rejected',
]);

export const draftSourceEnum = pgEnum('draft_source', [
  'local_qwen3',
  'cloud_haiku',
]);
```
</action>
<read_first>
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-01, D-03, D-16, D-17, D-21)
  - .planning/REQUIREMENTS.md  (MAIL-05 8-category list)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/db/enums.ts` exists
- `grep "'pending_admin'" dashboard/backend/src/db/enums.ts` matches
- `grep "'tuning_in_progress'" dashboard/backend/src/db/enums.ts` matches
- `grep "'cloud_haiku'" dashboard/backend/src/db/enums.ts` matches
- `grep "'awaiting_cloud'" dashboard/backend/src/db/enums.ts` matches
- `grep "'spam_marketing'" dashboard/backend/src/db/enums.ts` matches
- All 6 onboarding stages from D-16 appear as string literals
</acceptance_criteria>
</task>

<task id="2">
<action>
Create `dashboard/backend/src/db/schema.ts`. Every table lives in the `mailbox` schema via `pgSchema('mailbox').table(...)`. Column shapes match CONTEXT.md D-17 exactly for `draft_queue` (and the `sent_history`/`rejected_history` tables share the same columns minus `draft_queue`-specific workflow fields).

```ts
import {
  pgSchema,
  serial,
  bigserial,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  onboardingStageEnum,
  classificationCategoryEnum,
  draftQueueStatusEnum,
  draftSourceEnum,
} from './enums.js';

export const mailbox = pgSchema('mailbox');

// ── 1. email_raw ──────────────────────────────────────────────────────────
// Every inbound email lands here first, exactly once (unique on message_id).
export const emailRaw = mailbox.table(
  'email_raw',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    messageId: varchar('message_id', { length: 998 }).notNull(),
    threadId: varchar('thread_id', { length: 998 }),
    inReplyTo: varchar('in_reply_to', { length: 998 }),
    references: text('references'),
    fromAddr: varchar('from_addr', { length: 320 }).notNull(),
    toAddr: text('to_addr').notNull(),
    subject: text('subject'),
    bodyText: text('body_text'),
    bodyHtml: text('body_html'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqMessageId: uniqueIndex('email_raw_message_id_uq').on(t.messageId),
    idxReceivedAt: index('email_raw_received_at_idx').on(t.receivedAt),
  }),
);

// ── 2. classification_log ─────────────────────────────────────────────────
// Every classification attempt (including spam drops per D-21) lands here.
export const classificationLog = mailbox.table(
  'classification_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    emailRawId: integer('email_raw_id').notNull(),
    category: classificationCategoryEnum('category').notNull(),
    confidence: real('confidence').notNull(),
    modelVersion: varchar('model_version', { length: 64 }).notNull(),
    latencyMs: integer('latency_ms'),
    rawOutput: text('raw_output'),
    jsonParseOk: boolean('json_parse_ok').notNull(),
    thinkStripped: boolean('think_stripped').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxEmailRawId: index('classification_log_email_raw_id_idx').on(t.emailRawId),
    idxCategory: index('classification_log_category_idx').on(t.category),
  }),
);

// ── 3. draft_queue (D-17) ─────────────────────────────────────────────────
export const draftQueue = mailbox.table(
  'draft_queue',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    emailRawId: integer('email_raw_id').notNull(),
    // Denormalized original email fields for dashboard performance (D-17)
    fromAddr: varchar('from_addr', { length: 320 }).notNull(),
    toAddr: text('to_addr').notNull(),
    subject: text('subject'),
    bodyText: text('body_text'),
    bodyHtml: text('body_html'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    messageId: varchar('message_id', { length: 998 }),
    threadId: varchar('thread_id', { length: 998 }),
    inReplyTo: varchar('in_reply_to', { length: 998 }),
    references: text('references'),
    // Draft fields
    draftOriginal: text('draft_original'),              // NULL while awaiting_cloud
    draftSent: text('draft_sent'),                       // NULL until approved
    draftSource: draftSourceEnum('draft_source'),        // NULL while awaiting_cloud
    // Classification copy (denormalized from classification_log for one-query reads)
    classificationCategory: classificationCategoryEnum('classification_category').notNull(),
    classificationConfidence: real('classification_confidence').notNull(),
    // RAG refs: JSONB array of top-3 {chunkId, score, source}
    ragContextRefs: jsonb('rag_context_refs').notNull().default([] as unknown as object),
    // Workflow fields
    status: draftQueueStatusEnum('status').notNull().default('pending_review'),
    autoSendBlocked: boolean('auto_send_blocked').notNull().default(false), // D-04
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => ({
    idxStatus: index('draft_queue_status_idx').on(t.status),
    idxReceivedAt: index('draft_queue_received_at_idx').on(t.receivedAt),
    idxCategory: index('draft_queue_category_idx').on(t.classificationCategory),
    idxRagGin: index('draft_queue_rag_refs_gin').using('gin', t.ragContextRefs),
  }),
);

// ── 4. sent_history (D-19 archival target on approval) ────────────────────
export const sentHistory = mailbox.table(
  'sent_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    draftQueueId: integer('draft_queue_id').notNull(), // original row id for audit
    emailRawId: integer('email_raw_id').notNull(),
    fromAddr: varchar('from_addr', { length: 320 }).notNull(),
    toAddr: text('to_addr').notNull(),
    subject: text('subject'),
    bodyText: text('body_text'),
    threadId: varchar('thread_id', { length: 998 }),
    draftOriginal: text('draft_original'),
    draftSent: text('draft_sent').notNull(),
    draftSource: draftSourceEnum('draft_source').notNull(),
    classificationCategory: classificationCategoryEnum('classification_category').notNull(),
    classificationConfidence: real('classification_confidence').notNull(),
    ragContextRefs: jsonb('rag_context_refs').notNull().default([] as unknown as object),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxSentAt: index('sent_history_sent_at_idx').on(t.sentAt),
    idxCategory: index('sent_history_category_idx').on(t.classificationCategory),
  }),
);

// ── 5. rejected_history (D-19 archival target on reject) ──────────────────
export const rejectedHistory = mailbox.table(
  'rejected_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    draftQueueId: integer('draft_queue_id').notNull(),
    emailRawId: integer('email_raw_id').notNull(),
    fromAddr: varchar('from_addr', { length: 320 }).notNull(),
    subject: text('subject'),
    classificationCategory: classificationCategoryEnum('classification_category').notNull(),
    classificationConfidence: real('classification_confidence').notNull(),
    draftOriginal: text('draft_original'),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxRejectedAt: index('rejected_history_rejected_at_idx').on(t.rejectedAt),
  }),
);

// ── 6. persona (D-11 — single row per customer) ───────────────────────────
export const persona = mailbox.table('persona', {
  id: serial('id').primaryKey(),
  customerKey: varchar('customer_key', { length: 64 }).notNull().default('default'),
  statisticalMarkers: jsonb('statistical_markers').notNull(),       // JSONB per D-11
  categoryExemplars: jsonb('category_exemplars').notNull(),         // JSONB per D-11
  sourceEmailCount: integer('source_email_count').notNull().default(0),
  lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqCustomer: uniqueIndex('persona_customer_key_uq').on(t.customerKey),
}));

// ── 7. onboarding (D-16 state machine) ────────────────────────────────────
export const onboarding = mailbox.table('onboarding', {
  id: serial('id').primaryKey(),
  customerKey: varchar('customer_key', { length: 64 }).notNull().default('default'),
  stage: onboardingStageEnum('stage').notNull().default('pending_admin'),
  adminUsername: varchar('admin_username', { length: 64 }),
  adminPasswordHash: varchar('admin_password_hash', { length: 128 }),
  emailAddress: varchar('email_address', { length: 320 }),
  ingestProgressTotal: integer('ingest_progress_total'),
  ingestProgressDone: integer('ingest_progress_done').default(0),
  tuningSampleCount: integer('tuning_sample_count').default(0),
  tuningRatedCount: integer('tuning_rated_count').default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  livedAt: timestamp('lived_at', { withTimezone: true }),
}, (t) => ({
  uqCustomer: uniqueIndex('onboarding_customer_key_uq').on(t.customerKey),
  idxStage: index('onboarding_stage_idx').on(t.stage),
}));
```
</action>
<read_first>
  - dashboard/backend/src/db/enums.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-07..D-11 persona, D-13..D-16 onboarding, D-17..D-21 queue)
  - .planning/REQUIREMENTS.md  (MAIL-04, MAIL-11, RAG-04, PERS-03)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/db/schema.ts` exists
- `grep "pgSchema('mailbox')" dashboard/backend/src/db/schema.ts` matches
- `grep "export const draftQueue" dashboard/backend/src/db/schema.ts` matches
- `grep "export const emailRaw" dashboard/backend/src/db/schema.ts` matches
- `grep "export const classificationLog" dashboard/backend/src/db/schema.ts` matches
- `grep "export const sentHistory" dashboard/backend/src/db/schema.ts` matches
- `grep "export const rejectedHistory" dashboard/backend/src/db/schema.ts` matches
- `grep "export const persona" dashboard/backend/src/db/schema.ts` matches
- `grep "export const onboarding" dashboard/backend/src/db/schema.ts` matches
- `grep "auto_send_blocked" dashboard/backend/src/db/schema.ts` matches
- `grep "rag_context_refs" dashboard/backend/src/db/schema.ts` matches
- `grep "draft_source" dashboard/backend/src/db/schema.ts` matches
- `grep "statistical_markers" dashboard/backend/src/db/schema.ts` matches
- `grep "category_exemplars" dashboard/backend/src/db/schema.ts` matches
- `grep "'gin'" dashboard/backend/src/db/schema.ts` matches  (GIN index on rag_context_refs)
</acceptance_criteria>
</task>

<task id="3">
<action>
Create `dashboard/backend/src/db/types.ts` — convenience re-exports of inferred insert/select types that later plans will import without touching the schema file directly:

```ts
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import {
  emailRaw,
  classificationLog,
  draftQueue,
  sentHistory,
  rejectedHistory,
  persona,
  onboarding,
} from './schema.js';

export type EmailRaw = InferSelectModel<typeof emailRaw>;
export type NewEmailRaw = InferInsertModel<typeof emailRaw>;

export type ClassificationLog = InferSelectModel<typeof classificationLog>;
export type NewClassificationLog = InferInsertModel<typeof classificationLog>;

export type DraftQueueRow = InferSelectModel<typeof draftQueue>;
export type NewDraftQueueRow = InferInsertModel<typeof draftQueue>;

export type SentHistory = InferSelectModel<typeof sentHistory>;
export type NewSentHistory = InferInsertModel<typeof sentHistory>;

export type RejectedHistory = InferSelectModel<typeof rejectedHistory>;
export type NewRejectedHistory = InferInsertModel<typeof rejectedHistory>;

export type Persona = InferSelectModel<typeof persona>;
export type NewPersona = InferInsertModel<typeof persona>;

export type Onboarding = InferSelectModel<typeof onboarding>;
export type NewOnboarding = InferInsertModel<typeof onboarding>;
```
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/db/types.ts` exists
- `grep 'DraftQueueRow' dashboard/backend/src/db/types.ts` matches
- `grep 'NewEmailRaw' dashboard/backend/src/db/types.ts` matches
- `grep 'Onboarding' dashboard/backend/src/db/types.ts` matches
</acceptance_criteria>
</task>

<task id="4">
<action>
Rebuild the dashboard image with the new schema files and run a TS build to verify compilation. The updated image must embed the schema files so drizzle-kit can read them from inside the container.

```bash
docker compose build dashboard
docker compose up -d dashboard
# Confirm the backend starts cleanly (strict TS already caught schema errors at build time)
docker compose logs --since=30s dashboard | tail -40
```

Expected: no TS compile errors, dashboard container stays healthy after restart.
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts
  - dashboard/backend/src/db/enums.ts
  - dashboard/backend/src/db/types.ts
  - dashboard/Dockerfile
</read_first>
<acceptance_criteria>
- `docker compose build dashboard` exits 0
- `docker compose ps --format '{{.Service}} {{.Health}}' | grep '^dashboard healthy'` matches after restart
- `docker compose exec -T dashboard ls dist/backend/src/db/schema.js` exits 0
</acceptance_criteria>
</task>

<task id="5">
<action>
**[BLOCKING]** Run `drizzle-kit push` against the live Postgres container, targeting the `mailbox` schema. This is the mandatory schema-push step — the plan CANNOT pass verification without it. Plans 03–08 assume the tables exist as rows, not TypeScript types.

```bash
docker compose exec -T dashboard sh -c '
  export DATABASE_URL="postgresql://${POSTGRES_USER:-mailbox}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-mailbox}"
  npx drizzle-kit push --force
'
```

Note: `--force` skips the interactive confirmation that drizzle-kit normally prompts for; this is required because we are running inside a non-TTY container exec. The `mailbox` schema already exists from Phase 1's `scripts/init-db/00-schemas.sql`, so drizzle will push tables into it, not `public`, per the `schemaFilter: ['mailbox']` in `drizzle.config.ts`.
</action>
<read_first>
  - dashboard/drizzle.config.ts  (from Plan 01 — confirms schemaFilter)
  - dashboard/backend/src/db/schema.ts
  - scripts/init-db/00-schemas.sql  (mailbox schema exists)
</read_first>
<acceptance_criteria>
- `docker compose exec -T dashboard npx drizzle-kit push --force` exits 0
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='mailbox' AND table_name IN ('email_raw','classification_log','draft_queue','sent_history','rejected_history','persona','onboarding');"` returns `7`
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM pg_type WHERE typname IN ('onboarding_stage','classification_category','draft_queue_status','draft_source');"` returns `4`
</acceptance_criteria>
</task>

<task id="6">
<action>
Seed an `onboarding` row with `stage='pending_admin'` so the live gate in later plans has something to read. Create a one-off seed script at `dashboard/backend/scripts/seed-onboarding.ts`:

```ts
import { db } from '../src/db/client.js';
import { onboarding } from '../src/db/schema.js';
import { sql } from 'drizzle-orm';

async function main() {
  await db.insert(onboarding).values({
    customerKey: 'default',
    stage: 'pending_admin',
  }).onConflictDoNothing({ target: onboarding.customerKey });
  const rows = await db.execute(sql`SELECT customer_key, stage FROM mailbox.onboarding;`);
  console.log('onboarding rows:', rows.rows);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

Then run it once:

```bash
docker compose exec -T dashboard sh -c '
  npx tsx backend/scripts/seed-onboarding.ts
'
```
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts
  - dashboard/backend/src/db/client.ts
</read_first>
<acceptance_criteria>
- `dashboard/backend/scripts/seed-onboarding.ts` exists
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT stage FROM mailbox.onboarding WHERE customer_key='default';"` returns `pending_admin`
</acceptance_criteria>
</task>

</tasks>

<verification>
```bash
# 1. All 7 tables present in mailbox schema
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='mailbox'
  ORDER BY table_name;
" | sort | tr '\n' ' '
# Expected: classification_log draft_queue email_raw onboarding persona rejected_history sent_history

# 2. draft_queue column shape matches D-17
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='mailbox' AND table_name='draft_queue'
  ORDER BY ordinal_position;
"
# Must include: draft_source, classification_category, classification_confidence,
# rag_context_refs, auto_send_blocked, status, approved_at, sent_at

# 3. Enum values match D-16 for onboarding_stage
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT enumlabel FROM pg_enum
  WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname='onboarding_stage')
  ORDER BY enumsortorder;
" | tr '\n' ' '
# Expected: pending_admin pending_email ingesting pending_tuning tuning_in_progress live

# 4. draft_queue GIN index on rag_context_refs exists
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT indexname FROM pg_indexes
  WHERE schemaname='mailbox' AND tablename='draft_queue'
    AND indexname='draft_queue_rag_refs_gin';
"

# 5. Seed row exists
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT stage FROM mailbox.onboarding WHERE customer_key='default';
"
# Expected: pending_admin
```
</verification>
