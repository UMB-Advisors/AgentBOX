# Quick Task 260511-wsi: STAQPRO-331 #1 — Structured Reject Feedback

**Completed:** 2026-05-12
**Branch:** `feat/staqpro-331-reject-feedback` (off `origin/master`)
**Commit:** `a2172c7` — `feat(reject): structured feedback table + reason taxonomy (STAQPRO-331 #1)`
**Linear:** https://linear.app/staqs/issue/STAQPRO-331 (item #1 of 8)

## What shipped

End-to-end structured rejection feedback, replacing the prior free-text-into-`drafts.error_message` path that conflicted with the send-side semantic of that column.

### Backend

| Change | File |
|---|---|
| Migration 023 — new `mailbox.draft_feedback` table | `dashboard/migrations/023-create-draft-feedback-v1-2026-05-12.sql` |
| Const-tuple SoT for the 6 reason codes | `dashboard/lib/types.ts` (`REJECT_REASON_CODES`) |
| Fixture schema parity (kysely-codegen + tests source) | `dashboard/test/fixtures/schema.sql` |
| Kysely DB types regenerated | `dashboard/lib/db/schema.ts` |
| Structured zod body schema with `superRefine` for `other`→`free_text` invariant | `dashboard/lib/schemas/drafts.ts` |
| Transactional reject route: UPDATE drafts + INSERT draft_feedback in one tx | `dashboard/app/api/drafts/[id]/reject/route.ts` |

### Frontend

| Change | File |
|---|---|
| New popover component — 6-reason radio list + free-text + outside-click/Esc dismiss | `dashboard/components/RejectPopover.tsx` |
| Reject button now opens the popover; submits `{ reason_code, free_text }` | `dashboard/components/ActionButtons.tsx` |
| Wiring through to the queue list | `dashboard/components/DraftDetail.tsx`, `dashboard/components/QueueClient.tsx` |

### Tests

| Change | File |
|---|---|
| Schema invariant: `REJECT_REASON_CODES` ↔ `draft_feedback.reason_code` CHECK + tuple uniqueness | `dashboard/test/schema-invariants.test.ts` |
| Route tests: happy path, `other` w/o free_text → 400, missing reason_code → 400, already-approved → 409 | `dashboard/test/routes/drafts.test.ts` |
| Zod schema tests: empty body → fail, reason_code-only → ok, free_text trim, `other` requires free_text | `dashboard/lib/middleware/validate.test.ts` |

**Test status**: 272 passed / 81 skipped (DB-backed cases skip without `TEST_POSTGRES_URL`; CI runs them) / 0 failed.
**Typecheck**: clean except for the pre-existing `lib/queries-status.ts:195` error introduced by commit `b9d11e2` (STAQPRO-233) — unchanged by this work.

## Reason taxonomy (the structured signal)

| Code | Downstream consumer (deferred to STAQPRO-331 follow-ons) |
|---|---|
| `wrong_tone` | Persona resolver — tone, sign-off, formality overrides |
| `factually_inaccurate` | RAG eval harness — retrieval gap or hallucination signal |
| `missing_context` | RAG recall miss — tune `RAG_RETRIEVE_TOP_K`, sender filter |
| `should_reply_myself` | Classifier eval — reclassify category to `escalate` over time |
| `dont_reply` | Classifier miss — should have been `spam_marketing` |
| `other` | Free-text only — requires non-empty `free_text` at both zod and DB CHECK level |

## What did NOT ship (deferred to STAQPRO-331 follow-ons)

- Persona / RAG / classifier consumers that aggregate `draft_feedback` (item #1 unlocks them; doesn't implement them)
- "rejected: wrong tone" chip on the rejected-folder rows (cosmetic; no blocker)
- Items #2–#8 from STAQPRO-331 — see the issue for the suggested sub-issue split

## Deployment checklist (NOT done in this task)

The migration is not yet applied to either appliance. To roll out:

    # On each appliance (M1, M2)
    ssh mailbox1 'cd ~/mailbox && git pull && docker compose --profile migrate run mailbox-migrate'
    ssh mailbox1 'cd ~/mailbox && docker compose up -d --build --remove-orphans mailbox-dashboard'

Migration 023 is forward-only and additive (new table, no `drafts` schema change). Rollback path captured in the migration header comment: `DROP TABLE mailbox.draft_feedback;` plus revert of the route commit.

## Notes

- **Schema validation runs at the DB layer too** — the `(reason_code != 'other' OR free_text non-empty)` invariant is enforced by both the zod `superRefine()` and a Postgres CHECK constraint in migration 023. Defense in depth: if a non-dashboard caller (script, manual SQL) tries to insert an `other` row without free_text, Postgres rejects it.
- **Legacy `{ reason: string }` body shape is gone** — the planner originally specified a backwards-compat alias mapping legacy → `{ reason_code: 'other', free_text: reason }`, but the executor dropped it. Only the dashboard UI calls this route (verified via `grep -r '/api/drafts/.*/reject' --include='*.ts' --include='*.tsx'`), so the atomic UI port replaces the only caller — no compat surface needed.
- **`drafts.error_message` is now exclusively send-side** — the reject route no longer writes it. The state-machine documentation in root `CLAUDE.md` already described this as the intended semantic; this commit aligns the code with the doc.
