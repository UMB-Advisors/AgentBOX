---
plan_number: 02-04a
summary_version: v1
summary_date: 2026-04-29
status: PARTIAL — classifier infrastructure shipped; corpus + scoring + drafting handoff deferred
related_files:
  - 02-04-classification-routing-PLAN-v2-2026-04-27-STUB.md (source of intent)
  - dashboard/lib/classification/prompt.ts
  - dashboard/lib/classification/normalize.ts
  - dashboard/app/api/internal/classification-prompt/route.ts
  - dashboard/app/api/internal/classification-normalize/route.ts
  - dashboard/app/api/onboarding/live-gate/route.ts
  - dashboard/app/layout.tsx (system fonts)
  - dashboard/app/globals.css (system fonts)
  - n8n/workflows/01-email-pipeline-main.json
  - n8n/workflows/03-classify-email-sub.json
---

# 02-04a Summary — MAIL-05 classifier + classify sub-workflow

## What shipped

The classify path was decomposed out of the monolithic MailBOX workflow
into a dedicated sub-workflow with the prompt and normalization in
TypeScript modules, served at runtime via internal API. This closes
the prompt-drift risk that motivated D-29 and lays the foundation that
02-04b (corpus + scoring) and 02-07 (drafting) plug into.

### Dashboard

- **`lib/classification/prompt.ts`** — canonical Qwen3 prompt.
  - 8-category taxonomy per MAIL-05 (`inquiry`, `reorder`, `scheduling`,
    `follow_up`, `internal`, `spam_marketing`, `escalate`, `unknown`).
  - `/no_think` directive per D-05 for p95 < 5s (MAIL-06).
  - Pure `buildPrompt({from, subject, body})` function.
  - `routeFor(category, confidence)` helper encoding D-01/D-02 routing
    rule (`LOCAL_CONFIDENCE_FLOOR = 0.75`, LOCAL = reorder/scheduling/
    follow_up/internal, CLOUD = inquiry/escalate/unknown,
    spam_marketing → drop).
  - `MODEL_VERSION = 'qwen3:4b-ctx4k'` exported as the canonical
    model tag the workflow uses.

- **`lib/classification/normalize.ts`** — `<think>` token strip
  (MAIL-07) plus permissive JSON parse with hard fallback to
  `{category: 'unknown', confidence: 0, json_parse_ok: false}` per
  D-06. Handles closed `<think>...</think>` blocks, unclosed
  `<think>` prefixes, and markdown code fences.

- **`POST /api/internal/classification-prompt`** — D-29 source of
  truth. Accepts `{from, subject, body}`, returns
  `{prompt, model}`. POST instead of GET because email bodies don't
  fit a query string; same single-source-of-truth guarantee.

- **`POST /api/internal/classification-normalize`** — applies
  `normalizeClassifierOutput` to raw Ollama output. Keeps the
  normalization rules in code, not in the n8n workflow JSON.

- **`GET /api/onboarding/live-gate`** — D-49 boundary stub. Reads
  `mailbox.onboarding` (seeded `pending_admin` from 02-02-v2) and
  returns `{live, stage, bypass}`. Honors
  `MAILBOX_LIVE_GATE_BYPASS=1` env for dogfood. Fails closed on
  error (`live: false`, `stage: 'error'`) so the gate cannot
  accidentally permit drafting because the dashboard glitched.

- **`app/layout.tsx` / `app/globals.css`** — dropped `next/font/google`
  imports. The Jetson appliance routinely builds without DNS or with
  a stale clock (we hit `CERT_NOT_YET_VALID` on the first build),
  and pulling Google Fonts at build time is incompatible with that.
  System font stacks via CSS variables under `:root` keep the same
  CSS variable contract Tailwind expects (`--font-sans/mono/serif`).

### n8n

- **`MailBOX` (main)** — slimmed down. Schedule trigger now correctly
  carries `minutesInterval: 5` (the missing-key bug from the 02-03
  handoff). Classification nodes removed; main workflow is now:
  `Schedule(5min) → Gmail in:inbox(20) → Extract Fields →
  Insert Inbox (skipOnConflict on message_id) → Run Classify Sub`.
  The `skipOnConflict` filter is the "Fix C" dupe-suppression from
  the 02-03 carry-forward — only newly inserted rows propagate to
  classify, eliminating the per-cycle 20-Ollama-call waste.

- **`MailBOX-Classify` (new sub-workflow, id `MlbxClsfySub0001`)**:
  Execute Workflow Trigger `{inbox_message_id}` → `Load Inbox Row`
  → `Build Prompt` (HTTP to dashboard) → `Mark Start` (record start
  ms for latency_ms) → `Call Ollama` → `Normalize` (HTTP to
  dashboard) → `Shape Log Row` → `Insert Classification Log` →
  `Drop Spam?` IF: `category != 'spam_marketing'` →
  `Live Gate` (HTTP GET) → `Onboarding Live?` IF: `live === true` →
  `Insert Draft Stub` (mailbox.drafts row with classification fields,
  denormalized email fields, `auto_send_blocked = (category ===
  'escalate')` per D-04/D-32, placeholder `draft_body=''` and
  `model='pending'` because drafting hasn't shipped).

  **Drafting handoff is deliberately not wired** — 02-07 will append
  Execute Workflow nodes calling `04-draft-local-sub` /
  `05-draft-cloud-sub` after `Insert Draft Stub`. The drafts row is
  stub-shaped so 02-07 just UPDATES `draft_body` + `model` + flips
  `status`.

  Sub-workflow is `active=false` in `workflow_entity` — n8n correctly
  refuses to "activate" a workflow whose only entry point is an
  Execute Workflow Trigger (it's not a self-starting trigger).
  Invocation from main works regardless.

## Decisions made/confirmed

| ID | Decision | Outcome |
|----|----------|---------|
| D-29 | Source of truth for classifier prompt | Implemented as POST endpoint (deviation from D-29's literal "GET" — body too large for query string; same single-source-of-truth property) |
| D-30 | Routing decision location | Routing helper in TS exists for visibility, but the actual workflow does not yet branch on route — drafting handoff stub. 02-07 will add the IF node mirroring `routeFor()` |
| D-31 | Spam emails get classification_log row but no drafts row | Implemented exactly via the `Drop Spam?` IF node |
| D-32 | `auto_send_blocked` set on `escalate` category | Implemented as a boolean expression on the drafts INSERT |
| D-49 | Live-gate boundary | Stub endpoint shipped, defaults closed (no drafts until stage='live'). Bypass via env for dogfood |

## Live verification

- Dashboard rebuilt with system-font patch on Jetson; `docker compose
  ps mailbox-dashboard` reports `Up (healthy)`.
- All three new endpoints respond correctly to curl:
  - `classification-prompt` returns rendered Qwen3 prompt with the
    8-category description block.
  - `classification-normalize` strips `<think>...</think>` and returns
    `{category, confidence, json_parse_ok, think_stripped, raw_output}`.
  - `live-gate` returns `{live: false, stage: 'pending_admin',
    bypass: false}` because onboarding is still `pending_admin`.
- Both workflows imported into n8n via `n8n import:workflow`. DB
  state: `MailBOX active=t` (5 nodes), `MailBOX-Classify active=f`
  (12 nodes), schedule confirmed at `minutesInterval: 5`.
- **End-to-end verified 2026-04-30 06:35 UTC.** Deleted
  `mailbox.inbox_messages` id=929 to force re-ingestion on the next
  schedule fire. Schedule fired at 06:35:34, main workflow
  succeeded, classify sub succeeded, new `classification_log` row
  written:
  - `inbox_message_id=969` (id seq bumped from 929 — harmless)
  - `category='reorder'` (matched the email's "Re: Invoice 260203 Z"
    subject — operationally correct)
  - `confidence=0.9`
  - `model_version='qwen3:4b-ctx4k'`
  - `latency_ms=1757` (well under MAIL-06 p95 < 5s)
  - `json_parse_ok=t`, `think_stripped=f` (`/no_think` directive worked)
  - No drafts row was created — `mailbox.drafts` still at 2 — because
    the live-gate correctly blocked drafting at `stage='pending_admin'`
    (D-49 enforced as designed).

### Bug fixes during deploy

Three issues surfaced during the first scheduled fire and were
patched in-flight:

1. **Postgres queryReplacement type validation** — n8n's
   `executeQuery` requires `queryReplacement` to be a string or array,
   not a number. Wrapping with `String()` works (commit 19dbdf6).

2. **Execute Workflow Trigger `jsonExample` does not propagate
   `workflowInputs`** — caller's `{inbox_message_id: $json.id}`
   mapping never reached `$json.inbox_message_id` at the next node;
   `$json` was empty. Switched the trigger to `inputSource:
   "passthrough"` and dropped the caller's `workflowInputs` mapping,
   reading `$json.id` directly from the inserted row that flows in
   (commit 4f6df09).

3. **Sub-workflow `active=true` rejected by n8n** — Execute Workflow
   Trigger isn't a self-starting trigger. The DB activation flag was
   correctly set to `false`; calls from main still work because
   Execute Workflow node invokes the sub by id regardless of active
   state.

## Known issues / parked work

1. **Drafting handoff stubbed.** `MailBOX-Classify` ends after the
   drafts INSERT with no Execute Workflow node calling local/cloud
   drafting. 02-07 will append those.

2. **Existing legacy `MailBOX-Drafts` workflow.** Still active and
   uses NVIDIA NIM (per HANDOFF gotcha 1). It reads from
   `mailbox.drafts` rows which now have `model='pending'` until
   02-07 fills them. May need deactivation or a guard to avoid
   double-drafting when 02-07 lands.

3. **Live-gate deviation from D-49.** D-49 said classification
   "fires unconditionally". This implementation fires classification
   AND inserts the classification_log row unconditionally; the gate
   only blocks the drafts INSERT. Matches the spirit, not the letter.

4. **Failed executions during deploy persist in `execution_entity`.**
   Six `error` rows from the bug-fix iterations (executions 2997,
   2998, 3000, 3001, 3003, 3004) live in n8n's history. Cosmetic;
   safely visible in n8n Executions UI as "this is the trail of
   what we fixed". Will age out with n8n's default retention.

## Deferred to 02-04b (next plan)

- `scripts/heron-labs-score.mjs` — load corpus, build prompt via
  `lib/classification/prompt.ts`, call Ollama directly, normalize,
  compute accuracy by category.
- `scripts/heron-labs-corpus.sample.json` — 100 hand-labeled emails
  from real Heron Labs inbox history (PII redacted).
- MAIL-08 ≥80% accuracy gate.
- Confidence calibration spot-check.

## Deferred to 02-07

- `04-draft-local-sub.json` / `05-draft-cloud-sub.json` workflows.
- `lib/drafting/prompt.ts` (per D-42's same-pattern decision).
- `POST /api/internal/draft-prompt` endpoint.
- Drafting UPDATE pattern on the existing drafts row.
- Wire `Insert Draft Stub` → IF route → Execute Workflow drafting
  in `MailBOX-Classify`.

## Deferred to 02-08

- Real onboarding wizard (advances `mailbox.onboarding.stage`).
- This phase shipped a read-only stub for the live-gate boundary
  only.
