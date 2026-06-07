---
plan_number: 02-04
plan_version: v2-stub
plan_date: 2026-04-27
supersedes: 02-04-classification-routing-PLAN.md (v1, 2026-04-13)
status: SUPERSEDED — was STUB; split into 02-04a + 02-04b for execution
superseded_by: 02-04-classification-routing-SUMMARY.md (meta-summary consolidating the split)
split_into: [02-04a, 02-04b]
supersession_date: 2026-04-30
supersession_reason: Lean execution mode shipped 02-04a (MAIL-05 classifier + classify sub-workflow, 2026-04-29) and 02-04b (corpus + scoring + D-50 + MAIL-08 gate PASS, 2026-04-30) directly against this stub's intent. See meta-summary and individual SUMMARY files for what shipped.
slug: classification-routing
wave: 3
depends_on: [02-02, 02-03]
autonomous: false
requirements: [MAIL-05, MAIL-06, MAIL-07, MAIL-08, MAIL-09]
files_modified_estimate:
  - n8n/workflows/03-classify-email-sub.json
  - scripts/heron-labs-score.mjs
  - scripts/heron-labs-corpus.sample.json
  - dashboard/lib/classification/prompt.ts
  - dashboard/lib/classification/normalize.ts
---

<rescope_note>
**THIS IS A STUB. DO NOT EXECUTE.**

Captures shape and surfaces decisions for plan 02-04. Full task
breakdown deferred until the entire Phase 2 decision surface is
visible across the 02-03..08 stubs.

See `02-CONTEXT-ADDENDUM-v2-2026-04-27.md` for D-25..D-N decisions.
See `02-02-schema-foundation-PLAN-v2-2026-04-27.md` for active
schema patterns.
</rescope_note>

<changes_from_v1>

1. **File location**: v1's `dashboard/backend/src/classification/prompt.ts`
   becomes `dashboard/lib/classification/prompt.ts` (Next.js conventions;
   matches existing `dashboard/lib/queries.ts` pattern). Adding a
   `lib/classification/` subdir is the cleanest expansion of the
   existing layout.

2. **Tables**: v1 writes to `mailbox.draft_queue`; v2 writes to
   `mailbox.drafts` (kept as canonical, per 02-02-v2). Drops the spam
   path's `mailbox.classification_log` write but keeps the table
   reference (already created in 02-02-v2 migration 002).

3. **Existing classifications**: 6 rows in `mailbox.inbox_messages`
   already have `classification` set to legacy values (`test`,
   `action_required`). 02-04-v2 must NOT re-classify these; the
   classifier only fires for NEW IMAP-ingested rows from 02-03. The
   classification_log backfill from 02-02-v2 already normalized the
   legacy values to `'unknown'` for those 6 rows.

4. **Drafts table denormalization**: 02-02-v2 added denormalized email
   fields to `mailbox.drafts` (`from_addr`, `subject`, `body_text`,
   `received_at`, `message_id`, `thread_id`, etc. — D-17). The
   classification sub-workflow's INSERT to `mailbox.drafts` must
   populate these from the joined `inbox_messages` row, not just the
   minimal queue-record fields v1 assumed.

5. **Live-gate integration**: v1's plan 02-08 added a live-gate check
   to 02-04. v2 makes this dependency explicit: 02-04 calls
   `GET /dashboard/api/onboarding/live-gate` (defined in 02-08-v2)
   before firing the drafting sub-workflows. If `{live: false}`, the
   classification + log row are written but no draft row is created.
   This means tuning samples in 02-08 are generated from
   `inbox_messages` + `classification_log` directly, not from
   `drafts`.

</changes_from_v1>

<decisions_to_resolve>

**D-29 — Ollama invocation path from n8n**

Two architectural options:

- (a) n8n's built-in **Ollama Model node** (LangChain-style chat
  interface). Convenient but n8n holds the prompt template inside
  the workflow JSON (drift risk vs `lib/classification/prompt.ts`).
- (b) n8n **HTTP Request node** to `http://ollama:11434/api/generate`
  with the prompt loaded from a single source-of-truth file. n8n
  workflow stays thin; prompt drift impossible.

CLAUDE.md (project governance) recommends "n8n built-in AI Agent +
Ollama Model nodes" over Langchain — that argues for (a). But for
classification specifically, where prompt drift between scoring
script and live workflow would silently degrade MAIL-08 accuracy,
(b)'s single-source-of-truth wins.

Recommendation: **(b)**. The scoring script
(`scripts/heron-labs-score.mjs`) imports the prompt from
`lib/classification/prompt.ts`; the n8n workflow fetches the same
prompt at run-time via an HTTP call to a new Next.js endpoint
(e.g. `GET /dashboard/api/internal/classification-prompt`). One
canonical prompt, n8n's job is just to invoke Ollama with it.

Rejected: copy-paste the prompt into both the workflow JSON and
the scoring script (drift inevitable); use the Ollama Model node
and accept drift risk (silent accuracy degradation).

**D-30 — Routing decision location**

The routing decision (local Qwen3 vs cloud Haiku, based on category
+ confidence floor per D-01/D-02) currently lives in the n8n
workflow's IF node. Two options:

- (a) Keep routing in n8n workflow IF node (matches v1).
- (b) Centralize routing logic in `dashboard/lib/classification/route.ts`
  exposed as `GET /dashboard/api/internal/route?category=X&confidence=Y`,
  n8n calls the API for the routing decision.

(a) is simpler. (b) keeps the threshold tunable from a single TypeScript
function and lets the dashboard show "would-have-routed" diagnostics.
But it adds a network hop on every email.

Recommendation: **(a)**. Routing is a pure function of two inputs and
a constant; centralizing it adds latency for negligible benefit.
Document the routing rule in `02-CONTEXT-ADDENDUM` so it's discoverable
without reading workflow JSON.

Rejected: (b) — over-engineering for Phase 2 single-tenant scope.

**D-31 — Spam/marketing classification: drafts table or not**

D-21 (v1) says spam/marketing emails are logged to `classification_log`
but NOT inserted into `mailbox.draft_queue`. v2's table is `drafts`,
not `draft_queue`. Same rule applies — spam emails skip the drafts
table entirely. But the dashboard's existing `/api/drafts` route
JOINs `drafts` to `inbox_messages`, so spam emails would still appear
in `inbox_messages` (just without a draft).

Two options:

- (a) Spam emails appear in `inbox_messages` but never get a draft
  row. Dashboard's `/api/drafts` JOIN excludes them (LEFT JOIN
  returns NULL on draft side). UI hides rows with NULL drafts.
- (b) Spam emails are classified-then-deleted from `inbox_messages`.
  Only `classification_log` retains the audit trail.

(a) preserves the inbound corpus for future ML retraining + persona
extraction. (b) keeps the inbox table clean but loses ingestion
history. Storage cost is trivial (NVMe is huge).

Recommendation: **(a)**. Preserve everything ingested. Hide spam in
the UI at query time, not at storage time.

Rejected: (b) — irreversible, optimizes the wrong axis.

**D-32 — `auto_send_blocked` enforcement**

D-04 says `escalate` category sets `auto_send_blocked=true` on the
drafts row, and "no future auto-send rule (Phase 3) can fire" on it.
v2-stub note: enforcement of `auto_send_blocked=true` is purely a
Phase 3 concern (auto-send rules don't exist yet in Phase 2). 02-04
just needs to set the flag correctly on INSERT. Phase 3's auto-send
implementation will be responsible for honoring it.

This is not a decision needing resolution — just flagging that 02-04
ships the *flag*, Phase 3 ships the *enforcement*. No tests for
enforcement in 02-04's smoke test.

</decisions_to_resolve>

<dependencies_on_other_stubs>

- **02-03 (IMAP ingestion)**: 02-04's sub-workflow is invoked by 02-03's
  main workflow via Execute Workflow node. Contract: input
  `{ inbox_message_id: number }`, no return value (writes
  classification_log + drafts row as side effects). Must be defined
  in both stubs identically when promoted.

- **02-05 (RAG)**: independent. Classification doesn't read or write
  RAG.

- **02-06 (persona)**: independent. Persona is read by 02-07 (drafting),
  not by 02-04.

- **02-07 (draft generation)**: 02-04's sub-workflow ends by invoking
  one of 02-07's drafting sub-workflows (`04-draft-local-sub` for
  local Qwen3, `05-draft-cloud-sub` for Claude Haiku). Contract:
  input `{ drafts_id: number }`, drafting workflow updates the
  drafts row's `draft_original` field.

- **02-08 (onboarding wizard)**: 02-04 calls
  `GET /dashboard/api/onboarding/live-gate` before firing drafting.
  02-08-v2 must define this route. 02-04 ingests + classifies + logs
  unconditionally; the gate only suppresses drafting.

</dependencies_on_other_stubs>

<tasks_outline>

Sketch only; not executable.

1. Create `dashboard/lib/classification/prompt.ts` — canonical Qwen3
   prompt and the JSON schema for classifier output (single source
   of truth)
2. Create `dashboard/lib/classification/normalize.ts` — `<think>`
   token stripping + JSON parsing with hard fallback to `unknown`
   (D-06); used by both n8n (via API endpoint) and scoring script
3. Create `dashboard/app/api/internal/classification-prompt/route.ts`
   — read-only endpoint that returns the canonical prompt for n8n
   to consume (per D-29)
4. Create `n8n/workflows/03-classify-email-sub.json`:
   Execute Workflow trigger → fetch inbox_messages row →
   GET classification prompt → HTTP POST Ollama → strip-think + parse
   (via second helper API) → INSERT classification_log →
   IF spam → end (D-21, D-31)
   ELSE: GET live-gate → IF !live → end (no drafts row)
                     → ELSE: INSERT drafts (with auto_send_blocked
                             set to TRUE if escalate per D-04, D-32)
                         → IF local-route (D-01, D-02) →
                              Execute Workflow 04-draft-local-sub
                            ELSE → Execute Workflow 05-draft-cloud-sub
5. Create `scripts/heron-labs-score.mjs` — imports prompt from
   `dashboard/lib/classification/prompt.ts`, runs against the
   100-email test corpus, reports accuracy, exits non-zero on
   <80% (MAIL-08)
6. Create `scripts/heron-labs-corpus.sample.json` — 100-email hand-
   labeled test set, redacted PII, committed
7. Smoke test: send 5 representative test emails, verify each lands
   in classification_log with correct category + confidence + latency
   <5s; verify drafts row appears for non-spam; verify spam emails
   produce no drafts row but DO produce inbox_messages row + log entry

</tasks_outline>

<deferred_items>

- Active learning / retraining from operator corrections — Phase 3+
  (ADVN-01)
- Multi-language classification — English only for Phase 2
- Confidence calibration / ROC analysis — Phase 3 if MAIL-08 accuracy
  proves unstable in the wild

</deferred_items>
