---
plan_number: 02-03
summary_version: v1
summary_date: 2026-04-28
status: PARTIAL — minimal-scope intent shipped; remainder deferred to 02-04 work
related_files:
  - 02-03-imap-ingestion-watchdog-PLAN.md (v1, superseded)
  - 02-03-imap-ingestion-watchdog-PLAN-v2-2026-04-27-STUB.md (v2 stub, source of intent)
  - dashboard/migrations/007-add-thread-headers-to-inbox-messages-v1-2026-04-27.sql
  - n8n/workflows/01-email-pipeline-main.json
---

# 02-03 Summary — Schema migration + Gmail-driven ingestion with thread headers

## What shipped

**Schema migration (007):** Added `in_reply_to TEXT` and `references TEXT`
columns to `mailbox.inbox_messages`. Applied to live Postgres on
2026-04-27 via the migration runner committed in 02-02-v2. Existing 7 rows
preserved with NULL values in the new columns.

**MailBOX n8n workflow (canonical at `n8n/workflows/01-email-pipeline-main.json`):**
The Phase 1 dashboard sub-project shipped a workflow named `MailBOX` using
Gmail node (not IMAP) + Schedule Trigger. Per D-30 decision (the v2 stub's
IMAP-trigger + watchdog architecture was rendered moot — Gmail node has no
trigger-death bug), we extended that existing workflow rather than replacing it:

- Gmail node filter changed from `label:MailBOX-Test` to `in:inbox`
- Extract Fields node now extracts `inReplyTo` and `references` from
  Gmail node output
- Merge Classification node passes both threading columns through
- Store in DB node migrated from Execute Query to Insert mode (n8n
  Insert mode is comma-safe; the prior Execute Query mode had a
  silent parameter-binding bug on email bodies containing commas)
- On Conflict: Skip behavior preserved
- Workflow JSON exported and committed to git

**End-to-end validation:** A reply email landed at
`mailbox.inbox_messages.id=909` with both `in_reply_to` and `references`
populated. Confirmed via SELECT 2026-04-27.

## What got deferred to 02-04 work (not bugs in 02-03)

These were always going to be 02-04 concerns; calling them out here for
clarity since the v2 stub blurred the boundary:

- **Schedule trigger fires every 1 minute.** A UI rename to "Every 5 Min"
  did not persist the actual interval value (n8n quirk). With executeOnce
  off, this means up to 20 Ollama classifier calls per run.
- **Legacy classification taxonomy** (`action_required`, `informational`,
  `personal`, `spam`, `test`) still in use. MAIL-05 8-category migration
  is 02-04 work.
- **No filter-dupes-before-classify (Fix C from session log).** Each run
  classifies all 20 returned messages even if 19 already exist in the DB.
  Wasted Ollama calls; ON CONFLICT skip prevents data corruption but
  doesn't reduce compute.
- **executeOnce was set to true on the Classify node** in the original
  Phase 1 dashboard sub-project workflow, silently dropping 19 of every
  20 inbound emails. This was a real existing bug. Now toggled off
  during 02-03 work; full fix is filter-dupes-before-classify in 02-04.

## What was scoped in v2-stub but explicitly NOT done

- **IMAP trigger + watchdog (the v2 stub centerpiece):** Skipped because
  the live workflow uses Gmail node + Schedule Trigger, which has no
  trigger-death bug. Watchdog rationale obsolete.
- **`mailbox.watchdog_log` table:** Never created. Dashboard-only
  surfacing per D-28; failure visibility punted to Phase 3 alongside
  NOTF-01.
- **Import/export scripts (`scripts/n8n-import-workflows.sh`,
  `scripts/n8n-export-workflows.sh`):** Not built. Workflow JSON in git
  is currently authoritative-by-convention; n8n's running state is
  edited via the UI then re-exported. Acceptable for single-operator
  Phase 2; SM-65 drift detection remains a Phase 4+ concern.
- **`n8n/README.md`:** Not created. The committed workflow JSON's
  filename is self-documenting for now.

## Cosmetic issues in committed workflow JSON

The exported `01-email-pipeline-main.json` carries some n8n-UI artifacts
that are functionally harmless but ugly:
- Several Set-node field NAMES have a literal `=` prefix
  (`name: "=message_id"`)
- Some VALUES have double-equals prefix (`value: "=={{ $json.text }}"`)
These come from typing `=` in expression-mode fields where it was already
implicit. The data going to Postgres is clean (verified). The 02-04 work
will substantially restructure this workflow; cleanup happens then.

## Surprise: ID jump in `inbox_messages`

The `id` SERIAL sequence jumped from 26 to 909 during the debugging
session. Cause: failed n8n Insert experiments grabbed sequence values
without committing. Cosmetic only.

## Files in this commit chain

- `dashboard/migrations/007-add-thread-headers-to-inbox-messages-v1-2026-04-27.sql`
- `n8n/workflows/01-email-pipeline-main.json`
- `.planning/STATE.md` (updated)
- This summary file

## Next: 02-04 (classification + routing)

Resume at `.planning/phases/02-email-pipeline-core/02-04-classification-routing-PLAN-v2-2026-04-27-STUB.md`. Carries the deferred items above plus the architectural work the stub already specifies (canonical prompt API, MAIL-05 taxonomy migration, classification_log writes, routing decision, live-gate boundary).

---

## Addendum 2026-05-01 — Pub/Sub revert (D-51)

This SUMMARY described the live ingestion path as Gmail node + Schedule trigger, which is correct, but did not acknowledge that there was an interim Pub/Sub-push direction (DR-22) that also briefly shipped before being reverted. For session continuity:

- **DR-22** (Phase 2 v1 context) originally specified Gmail Pub/Sub push as the ingestion path. **STAQPRO-115** tracked the corresponding watch-renewal cron job and was **Cancelled 2026-04-30** ("DR-22 reverted per post-audit reviewer consensus").
- **STAQPRO-110** ("n8n classify + draft pipeline") originally shipped against the Pub/Sub-push variant; **STAQPRO-108** (Gmail Pub/Sub ingress) was re-opened during the revert.
- **Current canonical path (also what this SUMMARY documents):** n8n Gmail node + Schedule trigger every 5 minutes → `mailbox.inbox_messages` → `Execute Workflow` → MailBOX-Classify sub-workflow.
- **Captured as D-51** in `02-CONTEXT-ADDENDUM-v2-2026-04-27.md` with rationale, rejected alternatives, and carry-forward notes.

The 02-04a/02-04b classification work and the 02-07 drafting work both validated against the Schedule + Gmail node path, so no plan rework is required from D-51 — it is a decision capture, not a course-correction.
