---
plan_number: 02-03
plan_version: v2-stub
plan_date: 2026-04-27
supersedes: 02-03-imap-ingestion-watchdog-PLAN.md (v1, 2026-04-13)
status: SUPERSEDED — was STUB; partial-shipped against this stub's intent, see SUMMARY for what landed
superseded_by: 02-03-imap-ingestion-watchdog-SUMMARY.md
supersession_date: 2026-04-28
supersession_reason: Lean execution mode shipped the minimal-scope intent (migration 007 + Gmail+Schedule workflow extension) directly against this stub without first promoting it to a full v2 plan. SUMMARY documents what shipped and what was deferred. The IMAP-trigger + watchdog architecture in this stub was rendered moot per D-30.
slug: imap-ingestion-watchdog
wave: 3
depends_on: [02-02]
autonomous: false
requirements: [MAIL-01, MAIL-02, MAIL-03, MAIL-04, MAIL-05, MAIL-14]
files_modified_estimate:
  - n8n/workflows/01-email-pipeline-main.json
  - n8n/workflows/02-imap-watchdog.json
  - n8n/README.md
  - scripts/n8n-import-workflows.sh
---

<rescope_note>
**THIS IS A STUB. DO NOT EXECUTE.**

Captures shape and surfaces decisions for plan 02-03. Full task
breakdown deferred until the entire Phase 2 decision surface is
visible across the 02-03..08 stubs. Once cross-plan decisions are
resolved, this stub gets promoted to a full v2 plan with task list
and verification block.

See `.planning/STATE.md` ADR for context on the architectural pivot.
See `02-02-schema-foundation-PLAN-v2-2026-04-27.md` for the active
schema patterns (raw SQL migrations, hand-rolled `pg` queries).
</rescope_note>

<changes_from_v1>

1. **Table name**: v1 writes to `mailbox.email_raw`; this project ships
   `mailbox.inbox_messages` (kept from the Phase 1 dashboard sub-project,
   per 02-02-v2 reconciliation). Workflow JSON, INSERT statements, and
   downstream Execute Workflow handoffs all need to reference
   `inbox_messages` instead of `email_raw`.

2. **Existing rows**: 6 rows already exist in `inbox_messages` from the
   Phase 1 sub-project's dogfooding (mostly `[mailbox-test]` traffic from
   `dustin@heronlabsinc.com`). 02-03 ingestion does NOT need to backfill
   — those rows already classified through the older path. New rows
   inserted by 02-03's IMAP trigger should write to
   `mailbox.classification_log` (created in 02-02-v2) when classified.

3. **Schema columns**: `inbox_messages` already has the columns 02-03
   needs (`message_id`, `thread_id`, `from_addr`, `to_addr`, `subject`,
   `body`, `received_at`, `created_at`, `classification`, `confidence`,
   `classified_at`, `model`). v1's reference to `body_text` and
   `body_html` as separate columns is incorrect — `inbox_messages.body`
   is a single text column. v2 must extract plain text from HTML
   server-side (n8n Code node) before the INSERT, not store both.

4. **`in_reply_to` and `references` headers**: not currently stored in
   `inbox_messages`. 02-03-v2 needs to either (a) ALTER TABLE to add
   these columns (small migration 009), or (b) store them as JSON in a
   new metadata column. Decision below.

</changes_from_v1>

<decisions_to_resolve>

These cross-cut other Phase 2 plans. Resolve before promoting this
stub to a full plan.

**D-25 — `in_reply_to` and `references` storage**

The PRD (FR-MAIL-04) requires preserving threading headers so SMTP
replies in 02-07 thread correctly in the customer's mail client.
`mailbox.inbox_messages` doesn't have columns for these today.

Options:
- (a) ALTER TABLE inbox_messages ADD COLUMN in_reply_to TEXT, references TEXT —
  small forward migration 009; mirrors the columns already added to
  `mailbox.drafts` in 02-02-v2 migration 003
- (b) Store as JSONB in a new `headers JSONB` column — more flexible
  for future header preservation but more complex to query
- (c) Store on `drafts` only (already there from 02-02-v2 migration
  003); fetch from drafts when sending. Couples ingestion to drafts.

Recommendation: **(a)**. Cheap, mirrors existing pattern, queryable.

**D-26 — n8n workflow → schema write path**

Two architectural options for how n8n writes to Postgres:
- (a) n8n Postgres node directly INSERTs into `mailbox.inbox_messages`
  (matches v1; n8n holds Postgres credentials in its encrypted store)
- (b) n8n calls a Next.js API route (e.g. POST /dashboard/api/ingest)
  which performs the INSERT via `lib/queries.ts`-style helpers

(a) is simpler and matches Phase 1 sub-project's existing pattern. (b)
centralizes write logic in TypeScript code that's typechecked and
testable, but adds a network hop and another auth surface.

Recommendation: **(a) for ingestion** (high-frequency, simple shape).
Reserve (b) for state mutations that need cross-table consistency
(approve, reject — already shipped that way in `app/api/drafts/*`).

**D-27 — IMAP credentials storage**

v1 stores Gmail OAuth2 in n8n's encrypted credential store. This
remains correct. No change.

But: how does the *operator* enter those credentials? In v1's plan
02-08, the onboarding wizard writes them via the n8n credentials API.
That couples 02-08's onboarding to n8n's REST API. Alternative: have
the operator SSH in and configure n8n credentials manually during
white-glove onboarding. Less automated but more reliable.

Recommendation: defer to 02-08-v2 stub. 02-03 doesn't depend on the
storage UI — it just reads credentials by name from n8n's store.

**D-28 — Watchdog email destination**

v1's watchdog emails the operator on consecutive restart failures.
Email goes to the customer's own SMTP (D-23, MAIL-13) — which is the
same account being watched. Circular if SMTP itself is dead.

Options:
- (a) Send via customer SMTP anyway; accept the circularity
- (b) Send via Anthropic-side or third-party transactional SMTP
  (SendGrid, AWS SES) — adds a vendor dependency
- (c) Surface watchdog failures only on the dashboard (status page,
  Phase 4 deliverable) and skip email entirely for Phase 2

Recommendation: **(c) for Phase 2**, **(a) added in Phase 3** with
auto-send/notifications work (NOTF-01, NOTF-02). Drops scope and
removes a fragile dependency. Documented as deferred.

</decisions_to_resolve>

<dependencies_on_other_stubs>

- 02-04 (classification): receives `inbox_messages.id` via Execute
  Workflow handoff. 02-04-v2 stub must define the contract for this
  handoff (input shape, return shape on success/error).
- 02-05 (RAG): unaffected. Indexes sent_history, not inbound.
- 02-08 (onboarding wizard): the live-gate that 02-03's classification
  hand-off respects gets called via Next.js API
  (`/dashboard/api/onboarding/live-gate`, defined in 02-08-v2). 02-03
  must NOT short-circuit on the live gate itself — it should always
  ingest. The gate only blocks drafting in 02-04+.

</dependencies_on_other_stubs>

<tasks_outline>

Sketch only; not executable.

1. Add migration 009 for `in_reply_to` + `references` columns on
   inbox_messages (per D-25)
2. Create `n8n/workflows/01-email-pipeline-main.json`:
   IMAP trigger → extract headers → INSERT to inbox_messages →
   Execute Workflow `03-classify-email-sub`
3. Create `n8n/workflows/02-imap-watchdog.json`:
   5-min cron → check last execution timestamp → restart main
   workflow if stale → log to dashboard status (NOT email per D-28)
4. Create/update `scripts/n8n-import-workflows.sh` to import both
   workflow files into the running n8n container, fail if any
   workflow JSON contains inline credential values
5. Update `n8n/README.md` documenting the import process and the
   credentials-by-name pattern
6. Smoke test: send a real email to the dogfood inbox, verify a
   row appears in `mailbox.inbox_messages` within 90 seconds
   carrying all required headers

</tasks_outline>

<deferred_items>

- Operator email on watchdog failure (per D-28 recommendation;
  moves to Phase 3 with NOTF-01)
- Multi-account support (MAIL-14): single account for Phase 2
- Body HTML preservation: only `body_text` (extracted) stored;
  HTML discarded after extraction. Revisit if downstream draft
  generation needs the original HTML for reply formatting.

</deferred_items>
