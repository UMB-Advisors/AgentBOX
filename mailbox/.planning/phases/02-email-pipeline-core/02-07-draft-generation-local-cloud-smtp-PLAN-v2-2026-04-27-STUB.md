---
plan_number: 02-07
plan_version: v2-stub
plan_date: 2026-04-27
supersedes: 02-07-draft-generation-local-cloud-smtp-PLAN-v1-2026-04-13.md (Express architecture, archived)
superseded_by: 02-07-draft-generation-local-cloud-smtp-PLAN.md (canonical, v2 dated 2026-04-30)
supersession_date: 2026-04-30
supersession_reason: Stub promoted to full executable PLAN; decisions D-41..D-45 codified, task breakdown completed, threat model finalized.
status: SUPERSEDED — see 02-07-...-PLAN.md for the executable plan
slug: draft-generation-local-cloud-smtp
wave: 4
depends_on: [02-02, 02-04, 02-05, 02-06]
autonomous: false
requirements: [MAIL-10, MAIL-11, MAIL-12, MAIL-13, APPR-01, APPR-02]
files_modified_estimate:
  - dashboard/lib/drafting/prompt.ts
  - dashboard/lib/drafting/rag-snippet.ts
  - dashboard/lib/drafting/local.ts
  - dashboard/lib/drafting/cloud.ts
  - dashboard/lib/drafting/cost.ts
  - dashboard/lib/smtp/send.ts
  - dashboard/app/api/internal/draft-prompt/route.ts
  - dashboard/app/api/drafts/[id]/approve/route.ts (extend existing)
  - n8n/workflows/04-draft-local-sub.json
  - n8n/workflows/05-draft-cloud-sub.json
  - n8n/workflows/10-cloud-retry-worker.json
  - n8n/workflows/11-send-smtp-sub.json
---

<rescope_note>
**THIS IS A STUB. DO NOT EXECUTE.**

Captures shape and surfaces decisions for plan 02-07. Full task
breakdown deferred until 02-08 stub completes the Phase 2 surface.

See `02-CONTEXT-ADDENDUM-v2-2026-04-27.md` for D-25..D-N.
The original 02-CONTEXT.md decisions D-03 (graceful cloud
degradation), D-19 (sent/rejected history), D-22 (cost computation),
D-24 (thread header preservation) remain in force.
</rescope_note>

<changes_from_v1>

1. **File locations**: v1's `dashboard/backend/src/drafting/*` becomes
   `dashboard/lib/drafting/*`. v1's `routes/*.ts` Express handlers
   become App Router `app/api/*` routes. The existing
   `app/api/drafts/[id]/approve/route.ts` (Phase 1) is EXTENDED to
   trigger the SMTP send workflow rather than just marking approved.

2. **Tables**: v1 reads/writes `draft_queue`; v2 uses `mailbox.drafts`
   (kept as canonical, per 02-02-v2). 02-02-v2 already populated the
   denormalized email fields (`from_addr`, `subject`, `body_text`,
   `received_at`, `message_id`, `thread_id`, `in_reply_to`,
   `references`) on drafts, so the SMTP send workflow can read
   everything from a single row without joining inbox_messages.

3. **Existing approve API**: `app/api/drafts/[id]/approve/route.ts`
   already exists from Phase 1. Currently it just sets
   `status='approved'` and `approved_at=NOW()`. v2 extends it to also
   invoke the SMTP send workflow (via n8n REST API webhook or a
   direct call to `dashboard/lib/smtp/send.ts`). See D-43 below for
   that decision.

4. **Retry mechanism**: v1's `retry_count` column doesn't exist on
   `mailbox.drafts`. Phase 1 already added an `error_message` column.
   02-07-v2 needs to add `retry_count` via a small migration 011
   (similar to D-25's pattern: cheap forward migration for column
   additions).

5. **Cost tracking**: 02-02-v2 dropped the `cost_usd numeric(10,6)`
   column from `mailbox.drafts` (was there in Phase 1 — wait, it's
   still there per the live API response we verified earlier, just
   defaulted to '0.000000'). The cloud path needs to populate this
   field on successful Haiku call. Local path leaves it at 0.

</changes_from_v1>

<decisions_to_resolve>

**D-41 — Drafting prompt source-of-truth**

Same anti-drift pattern as D-29 (classification prompt). The system
prompt + user prompt builder for drafting is referenced by:
- Local path (n8n → Ollama HTTP)
- Cloud path (n8n → Anthropic API or → Next.js → Anthropic SDK; see D-42)
- Future tuning UI (02-08) might re-render exemplar drafts using
  the same prompts

**Decision:** Canonical prompt at `dashboard/lib/drafting/prompt.ts`.
Two functions exported: `buildSystemPrompt(persona)` and
`buildUserPrompt(inbound, ragRefs, categoryExemplars)`. Exposed via
`POST /dashboard/api/internal/draft-prompt` for n8n consumption
(takes drafts row id, returns rendered system + user prompts ready
for LLM invocation). Single source, no drift.

The endpoint is POST not GET because building the prompt requires
loading persona JSON, RAG context, and category exemplars — the
inputs don't fit cleanly in a query string and the operation has
side-effect potential (RAG search) so cache semantics differ.

Rejected: copy prompts into both workflow JSONs (drift risk);
different prompts for local vs cloud (defeats the v1 "draft_source
is the only difference" guarantee).

**D-42 — Anthropic API invocation path**

Anthropic SDK is TypeScript-native. Two ways to call it from the
cloud-drafting workflow:

- (a) n8n's HTTP Request node calls Anthropic's REST API directly.
  Workflow JSON contains the full request shape. Simpler from
  n8n's perspective; no Next.js dependency.
- (b) n8n calls a Next.js endpoint
  `POST /dashboard/api/internal/draft-cloud` which uses the
  Anthropic TS SDK. Centralizes the SDK in TypeScript; easier to
  mock for testing, easier to add retry/streaming/observability.

Unlike Ollama (D-29) where the HTTP node won, Anthropic's case is
different: the SDK provides retry semantics, error typing, streaming
support, and prompt caching that re-implementing in n8n's
expression language is painful.

**Decision:** **(b)**. Cloud drafting goes through Next.js. The
endpoint accepts `{ drafts_id, system, user }`, calls Anthropic
SDK, returns `{ draft_text, input_tokens, output_tokens, cost_usd,
model }`. n8n's job is to fetch the prompt (D-41), call this
endpoint, and persist the response to drafts row.

The cost tracking (D-22) lives in `dashboard/lib/drafting/cost.ts`
and is computed inside the cloud endpoint before returning, so the
n8n workflow doesn't need pricing constants.

Rejected: HTTP node directly to Anthropic (loses SDK ergonomics,
duplicates retry logic in n8n). The latency cost of the extra
network hop (n8n → Next.js → Anthropic) is negligible since
Anthropic itself adds 500ms-3s of latency that dwarfs the local hop.

**D-43 — Approve flow → SMTP send trigger**

The existing `app/api/drafts/[id]/approve/route.ts` runs in Next.js
when the operator clicks Approve. It needs to trigger the SMTP send
workflow. Two options:

- (a) Approve API directly invokes
  `dashboard/lib/smtp/send.ts` synchronously. Operator sees the
  result inline; no n8n round-trip. SMTP failure = approve fails =
  row stays in `approved` state without `sent_at`.
- (b) Approve API marks `status='approved'`, returns 200, then
  enqueues the SMTP send via n8n webhook. Workflow handles send
  asynchronously; updates `sent_at` and moves to sent_history on
  success or back to `failed` status on failure.

(a) gives clean inline error reporting but ties up the API request
on a slow SMTP server. (b) decouples cleanly but adds latency and a
second failure surface.

**Decision:** **(a)** for Phase 2 single-tenant scale. SMTP latency
is dominated by Gmail (200-500ms typical); blocking the approve
request is acceptable. The `dashboard/lib/smtp/send.ts` helper is
small, testable, and produces clear error responses for the UI.

The send code reads thread headers from the same drafts row
(denormalized in 02-02-v2 migration 003), constructs the email with
proper `In-Reply-To`/`References` per D-24, sends via `nodemailer`,
on success moves the row to `mailbox.sent_history` (per D-19), on
failure sets `status='failed'` and `error_message` for retry-via-UI.

n8n is NOT involved in the post-approve send path. n8n owns
ingestion + classification + drafting; Next.js owns approval +
sending. Clear separation of concerns by workflow phase.

Rejected: (b) — over-engineered for single-tenant. Move to (b) when
multi-tenancy or high send volume justifies it.

**D-44 — Retry worker for awaiting_cloud**

D-03 specifies graceful degradation: when Anthropic is unreachable,
the row enters `status='awaiting_cloud'` with `draft_original=NULL`.
A worker re-drives these rows when the API is reachable.

v1 spec: 5-minute n8n cron checks for `awaiting_cloud` rows, retries
the cloud draft, with `retry_count` bounded at 10 before giving up.

**Decision:** Keep the v1 design. Workflow `10-cloud-retry-worker`
runs every 5 minutes. Adds migration 011 to introduce `retry_count
INTEGER NOT NULL DEFAULT 0` on `mailbox.drafts`. After 10 failures,
row moves to `mailbox.rejected_history` with note "exceeded retry
budget" and the inbound stays in `inbox_messages` for manual
intervention.

Per D-26, the retry worker writes directly to Postgres for the
counter increment but invokes the cloud-draft endpoint (per D-42)
for the actual retry attempt.

Rejected: exponential backoff (more complex; 5-min cron is
sufficient for transient cloud issues at single-tenant scale);
unbounded retry (infinite-loop on permanently bad rows).

**D-45 — Egress inventory boundary**

The threat model in v1 says: "only persona profile + top-3 RAG refs
+ inbound email body leave the appliance per draft. No full sent
corpus, no customer contact list, no operator credentials."

This is a values/constraint statement that needs to live somewhere
authoritative. v1 documents it inline in the threat table. v2 should
codify this as a boundary that's testable.

**Decision:** Define an explicit allowlist in
`dashboard/lib/drafting/cloud.ts`: the egress payload to Anthropic is
constructed by an `assembleCloudPrompt()` function whose return type
is a typed union of explicitly-allowed fields. TypeScript prevents
accidentally adding a field by way of an interface change.

Test: a unit test asserts that `assembleCloudPrompt()` output, when
JSON-stringified, contains no field names from a denylist (e.g.
'sent_history', 'persona.statistical_markers.vocabulary_top_terms'
beyond top-N, 'inbox_messages' bulk arrays). Run as part of the
typecheck pipeline.

This is the kind of thing that's easy to break by accident in a
later edit ("oh let's just include the full persona for better
results") and impossible to detect without explicit guardrails.

Rejected: rely on code review / inline doc strings (regression
risk); send minimal data and re-fetch on Anthropic side (Anthropic
doesn't have access to the appliance, so this isn't possible).

</decisions_to_resolve>

<dependencies_on_other_stubs>

- **02-04 (classification)**: invokes 02-07's drafting sub-workflows
  via Execute Workflow node. Contract `{ drafts_id: number }`. Local
  vs cloud path selection happens in 02-04's IF node (D-30).

- **02-05 (RAG)**: 02-07's prompt builder calls
  `POST /dashboard/api/internal/rag-search` (D-37) to get top-3 refs.
  Persists `rag_context_refs` JSONB to drafts row.

- **02-06 (persona)**: 02-07 reads persona via `getPersona()` from
  `lib/queries-persona.ts`. If persona doesn't exist yet (pre-tuning),
  drafting fails fast — the live-gate from 02-08 (D-43 boundary)
  prevents drafting until persona is ready.

- **02-08 (onboarding wizard)**: live-gate enforcement. Until
  onboarding stage is `live`, classification logs but no drafts row
  is created (per D-32 boundary set in 02-04). Tuning samples
  generated by 02-08 use the same drafting code path with a
  TUNING-flag input that bypasses the live-gate.

</dependencies_on_other_stubs>

<tasks_outline>

Sketch only; not executable.

1. Add migration 011: ALTER TABLE drafts ADD COLUMN retry_count
   (per D-44)
2. Create `dashboard/lib/drafting/prompt.ts` — system + user prompt
   builders (D-41)
3. Create `dashboard/lib/drafting/rag-snippet.ts` — formatter that
   takes top-3 RAG results and renders them for prompt inclusion
4. Create `dashboard/lib/drafting/local.ts` — Ollama HTTP wrapper
   for Qwen3 drafting (called by n8n local-draft workflow)
5. Create `dashboard/lib/drafting/cloud.ts` — Anthropic SDK wrapper
   with `assembleCloudPrompt()` egress allowlist (D-42, D-45)
6. Create `dashboard/lib/drafting/cost.ts` — pricing constants and
   cost computation (D-22)
7. Create `dashboard/lib/smtp/send.ts` — nodemailer wrapper with
   thread-header preservation (D-24)
8. Create `dashboard/app/api/internal/draft-prompt/route.ts` —
   POST builds and returns rendered prompts (D-41)
9. Create `dashboard/app/api/internal/draft-cloud/route.ts` —
   POST invokes Anthropic SDK, returns drafted text + metadata
   (D-42)
10. EXTEND `dashboard/app/api/drafts/[id]/approve/route.ts` — after
    setting status=approved, call `lib/smtp/send.ts` synchronously,
    move to sent_history on success (D-43)
11. EXTEND `dashboard/app/api/drafts/[id]/reject/route.ts` — move
    to rejected_history (D-19)
12. Create `n8n/workflows/04-draft-local-sub.json`:
    Execute Workflow trigger → fetch drafts row →
    GET draft prompt (canonical via D-41) → HTTP POST Ollama →
    UPDATE drafts SET draft_original=..., draft_source='local_qwen3',
    rag_context_refs=...
13. Create `n8n/workflows/05-draft-cloud-sub.json`:
    Execute Workflow trigger → fetch drafts row →
    GET draft prompt → POST /api/internal/draft-cloud (D-42) →
    UPDATE drafts SET draft_original=..., draft_source='cloud_haiku',
    cost_usd=..., input/output_tokens=...
    On API failure: SET status='awaiting_cloud', exit
14. Create `n8n/workflows/10-cloud-retry-worker.json`:
    5-min cron → SELECT awaiting_cloud rows → retry via
    cloud-draft endpoint → bump retry_count → if retry_count >= 10,
    move to rejected_history
15. Create `n8n/workflows/11-send-smtp-sub.json`:
    NOT NEEDED per D-43. Remove from files_modified_estimate.
    Approve API handles SMTP synchronously.
16. Smoke test: send a real test email, walk it through classification
    → draft → approve in the dashboard UI, verify SMTP send to
    self with proper threading, verify row in sent_history. Repeat
    with cloud path by forcing a low-confidence classification.
    Repeat with `awaiting_cloud` by temporarily breaking the
    Anthropic key, verify retry worker recovers.

</tasks_outline>

<deferred_items>

- Streaming responses from Anthropic (better UX) — Phase 3
- Auto-send rules (Phase 3, NOTF-01) — `auto_send_blocked` flag
  set here is honored there
- Multiple SMTP accounts (per-customer in multi-tenant) — Phase 3+
- Prompt caching for repeated category exemplars (Anthropic feature)
  — Phase 2.5 if cost becomes meaningful
- Operator-tunable temperature / model selection — Phase 3+
- Bounce handling / DSN parsing — Phase 3+ with NOTF work

</deferred_items>
