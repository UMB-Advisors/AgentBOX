---
plan_number: 02-06
plan_version: v2-stub
plan_date: 2026-04-27
supersedes: 02-06-persona-extract-refresh-PLAN.md (v1, 2026-04-13)
status: STUB — defer full task breakdown until cross-plan decisions resolved
slug: persona-extract-refresh
wave: 3
depends_on: [02-02, 02-05]
autonomous: false
requirements: [PERS-01, PERS-02, PERS-03, PERS-04, PERS-05]
files_modified_estimate:
  - dashboard/lib/persona/stats.ts
  - dashboard/lib/persona/exemplars.ts
  - dashboard/lib/persona/build.ts
  - dashboard/app/api/persona/route.ts
  - dashboard/app/api/persona/extract/route.ts
  - n8n/workflows/08-persona-monthly-refresh.json
  - n8n/workflows/09-persona-extract-trigger.json
---

<rescope_note>
**THIS IS A STUB. DO NOT EXECUTE.**

Captures shape and surfaces decisions for plan 02-06. Full task
breakdown deferred until 02-03..08 stubs are complete.

See `02-CONTEXT-ADDENDUM-v2-2026-04-27.md` for D-25..D-N.
The original 02-CONTEXT.md decisions D-07..D-11 (hybrid persona,
monthly refresh, single-row table, gap reporting) remain in force.
</rescope_note>

<changes_from_v1>

1. **File locations**: v1's `dashboard/backend/src/persona/*` becomes
   `dashboard/lib/persona/*`. Express router `routes/persona.ts`
   splits into App Router files at `app/api/persona/route.ts`
   (GET) and `app/api/persona/extract/route.ts` (POST).

2. **Persona table**: v1's `mailbox.persona` already exists from
   02-02-v2 (migration 005) with the exact JSONB shape v1 spec'd:
   `statistical_markers JSONB`, `category_exemplars JSONB`,
   `source_email_count INTEGER`, `last_refreshed_at TIMESTAMPTZ`.
   No schema changes needed.

3. **Read source for persona extraction**: v1 reads from
   `mailbox.sent_history` for both extraction and monthly refresh.
   The sent-history table exists from 02-02-v2 (migration 004) but
   is currently EMPTY — it only gets populated by the approve-flow
   in 02-07 going forward. There's no historical data in it.

   Persona extraction during onboarding needs the customer's
   *actual* email-writing history (6 months of sent mail per
   v1/02-05). That's NOT in `sent_history` — that's coming from
   IMAP `Sent Mail` folder ingestion in 02-05's
   `06-rag-ingest-sent-history` workflow.

   See decision D-38 below for where that ingested data lands.

4. **Type imports**: 02-02-v2 added `Persona` interface and
   `getPersona()` / `upsertPersona()` to `dashboard/lib/queries-
   persona.ts`. The persona builder in 02-06-v2 calls `upsertPersona`
   from there rather than writing its own SQL. Single canonical
   write path.

</changes_from_v1>

<decisions_to_resolve>

**D-38 — Sent-history storage table**

The forced-to-ground question from 02-05's stub. Two options for
where IMAP `Sent Mail` folder rows land:

- (a) **Existing `mailbox.inbox_messages` table** with a new
  `direction` column (`'inbound' | 'sent'`). Forward migration 010
  ALTER TABLE inbox_messages ADD COLUMN direction TEXT NOT NULL
  DEFAULT 'inbound'. Rename the table to something direction-neutral
  like `mailbox.email_messages` later if it bothers anyone.

- (b) **New table `mailbox.sent_emails`** mirroring the
  `inbox_messages` shape minus `classification` fields. Two parallel
  tables; sent_history (post-approval) becomes "sent emails Claude
  drafted" while sent_emails is "sent emails the operator wrote
  historically." Three sent-related tables total
  (inbox_messages, sent_emails, sent_history) — confusing.

- (c) **Reuse `mailbox.sent_history` for both** — operator's
  historical sends backfilled there during onboarding, Claude-
  drafted sends added going forward. One column distinguishes
  source (`source='backfill'` vs `source='draft'`).

(a) is simplest schema-wise but the table name `inbox_messages`
becomes a misnomer. (b) keeps tables single-purpose but adds count.
(c) repurposes a table whose semantics in v1 were specifically
"approved+sent drafts" — semantic drift.

**Decision:** **(a)**. ALTER TABLE inbox_messages ADD COLUMN
direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN
('inbound', 'sent')). Add migration 010. Update the existing 6
rows: all are inbound (DEFAULT handles it). Future IMAP Sent Mail
ingest writes with `direction='sent'`. Rename table later if/when
it bothers us; cheap to rename via migration.

The semantic awkwardness of "inbox_messages" containing sent
emails is real but outweighed by the simplicity of one storage
table. `sent_history` keeps its v1 meaning: post-approval Claude
drafts. Persona reads from `inbox_messages WHERE direction='sent'`.

Rejected: separate sent_emails table (over-decomposed); reusing
sent_history (semantic drift; sent_history columns are tuned for
draft-tracking like `draft_original`/`draft_sent` that don't fit
backfilled operator email).

**D-39 — Persona extraction compute location**

Statistical markers are pure-TS functions (cheap). Category
exemplar selection involves loading sent-history bodies, grouping
by category, picking top-N representative samples. Three options:

- (a) Run the whole extraction in the Next.js API route as one
  request: `POST /api/persona/extract` blocks until done, returns
  the new persona row. Could take 30+ seconds for 6 months of mail.
- (b) Background job: API route enqueues a job in Postgres (e.g.
  in a `jobs` table or on `mailbox.onboarding`), returns 202.
  Worker (n8n cron, every 30s) picks up the job, runs extraction,
  updates persona + onboarding state. UI polls.
- (c) n8n workflow does the extraction directly: trigger sub-workflow
  `09-persona-extract-trigger` from onboarding. n8n calls TS helpers
  via API endpoints for the stats math, persists to persona table.

(a) is a UX problem (long blocking request) and a Next.js timeout
risk (default 60s on API routes). (b) is more work for marginal
benefit at single-tenant Phase 2. (c) matches v1's design and keeps
n8n as the orchestrator for long-running multi-step work.

**Decision:** **(c)**. The trigger workflow `09-persona-extract-
trigger` reads sent emails from `inbox_messages WHERE
direction='sent'` (per D-38), groups by category via JOIN with
classification_log (or via a `category` column on inbox_messages
if we add it), invokes Next.js helpers via API for the heavy stats
math, builds the persona JSON, and writes via Next.js API which
calls `upsertPersona()` from queries-persona.ts.

The "stats math via API" sub-decision: there's a single
`POST /dashboard/api/internal/persona-build` endpoint that takes a
list of sent email bodies + categories and returns the
StatisticalMarkers + CategoryExemplars JSON. n8n's job is just to
fetch the inputs and persist the output. All TypeScript stays in
Next.js where it can be tested.

Rejected: API-route-blocks (timeout risk); background-job
table (premature complexity).

**D-40 — Categorizing historical sent emails**

Persona needs sent emails grouped by category to build per-category
exemplars (D-09: "3–5 per-category exemplars"). For *new* drafts
post-onboarding, classification of the inbound determines the
category, and the resulting sent email inherits that category via
sent_history's `classification_category` column.

For *backfilled* historical sent email (the 6-month onboarding
ingest), there's no inbound classification — these are operator-
written replies to inbounds that pre-date the appliance.

Three options:
- (a) Skip category grouping for backfilled sent emails. Only use
  them for *statistical* markers (which are category-agnostic).
  Category exemplars get populated organically from post-
  onboarding sent_history once enough drafts have been approved.
  Tuning samples in 02-08 fill the gap during white-glove launch.
- (b) Run the historical sent emails through the *classifier*
  during ingestion. Slower ingest but gets per-category exemplars
  on day 1.
- (c) Pair each historical sent with its inbound (matched via
  `in_reply_to` / Gmail thread_id) and inherit the inbound's
  classification. Skip sent emails with no matching inbound.

(b) is the cleanest answer but adds 2-5 sec per email × thousands
of emails = potentially hours of onboarding ingest time. (c) is
elegant but depends on the inbound being in the same 6-month
window AND being classifiable AND threading metadata being
preserved.

**Decision:** **(c) with (a) fallback.** Pair sent with inbound via
`thread_id`/`in_reply_to` where possible (the inbound also got
ingested in the same 6-month sweep). When pairing succeeds, classify
the inbound and inherit the category. When pairing fails (no inbound
in window, missing thread headers), the sent email contributes to
*statistical markers only*. Tuning samples (02-08) fill gaps in
per-category exemplars during white-glove handoff.

Rejected: (a) alone (loses the natural pairing that actually exists
in most operator workflows); (b) (slow ingest, doesn't degrade
gracefully).

</decisions_to_resolve>

<dependencies_on_other_stubs>

- **02-05 (RAG)**: 02-06 reads sent emails from `inbox_messages` (per
  D-38) which 02-05's `06-rag-ingest-sent-history` populates from
  IMAP. 02-05's workflow must be updated to write rows to
  `inbox_messages` with `direction='sent'`. RAG indexing of those
  rows continues unchanged.

- **02-04 (classification)**: 02-06 calls the classifier on
  backfilled sent emails (per D-40 (c)) by invoking the same prompt
  + parser used for inbound classification. 02-06's bulk-classify
  path goes through the same `lib/classification/` helpers.

- **02-07 (drafting)**: 02-07 reads `mailbox.persona` to compose
  prompts. 02-06 produces the persona row. After 02-07 ships, the
  approved drafts feed back into `sent_history` which feeds back into
  the monthly refresh. Closed loop.

- **02-08 (onboarding wizard)**: 02-08 invokes 02-06's
  `09-persona-extract-trigger` workflow after sent-history ingest
  completes and waits for persona row to be populated before
  advancing onboarding to `pending_tuning` stage. 02-08 also covers
  tuning sample creation which fills per-category exemplar gaps
  identified by 02-06 (D-09 / D-40 fallback path).

</dependencies_on_other_stubs>

<tasks_outline>

Sketch only; not executable.

1. Add migration 010: ALTER TABLE inbox_messages ADD COLUMN
   direction (per D-38)
2. Create `dashboard/lib/persona/stats.ts` — pure deterministic
   statistical marker functions (avg sentence length, formality,
   greeting/closing frequencies, vocabulary top terms)
3. Create `dashboard/lib/persona/exemplars.ts` — per-category
   exemplar selection from a list of sent emails grouped by
   category. Selects 3-5 representative samples; gap-tracks
   categories with <3
4. Create `dashboard/lib/persona/build.ts` — orchestration:
   takes a list of `{ body_text, category, sent_at, ... }`, returns
   `{ statistical_markers, category_exemplars, gaps }`
5. Create `dashboard/app/api/persona/route.ts` — GET returns current
   persona row (proxy to `getPersona()`)
6. Create `dashboard/app/api/persona/extract/route.ts` — POST
   triggers the n8n extract workflow (or runs synchronously for
   <100-email corpora; bypass n8n at small scale)
7. Create `dashboard/app/api/internal/persona-build/route.ts` —
   POST, takes the list-of-emails input, returns the built JSON
   for n8n to persist (per D-39)
8. Create `n8n/workflows/09-persona-extract-trigger.json`:
   Trigger (webhook from onboarding) → query inbox_messages for
   sent rows → pair with inbounds via thread_id (D-40) →
   batch-classify unpaired (D-40) → POST to
   /api/internal/persona-build → upsert persona via API
9. Create `n8n/workflows/08-persona-monthly-refresh.json`:
   Cron 1st of month 02:00 local → query last 30 days of
   sent_history (post-onboarding sends) + retain historical
   exemplars from inbox_messages → rebuild → upsert
10. Smoke test: run the extract workflow against the 6 dogfood
    inbox_messages rows (after they're flagged direction='inbound')
    plus a few seeded sent rows; verify persona JSON populates;
    verify gap-tracking works for categories with no samples

</tasks_outline>

<deferred_items>

- Multi-customer persona support — Phase 3+ via `customer_key`
  partitioning (already in the persona table schema)
- Voice-drift detection (alert when statistical markers shift
  significantly month-over-month) — Phase 3+
- Operator-editable persona ("override formality_score to 0.6") —
  Phase 3+; for now persona is read-only via the dashboard
- Active learning from operator edits to drafts — Phase 3 with
  ADVN-01

</deferred_items>
