---
plan_number: 02-08
plan_version: v2-stub
plan_date: 2026-04-27
supersedes: 02-08-onboarding-wizard-and-queue-api-PLAN.md (v1, 2026-04-13)
status: STUB — defer full task breakdown until cross-plan decisions resolved
slug: onboarding-wizard-and-queue-api
wave: 5
depends_on: [02-02, 02-03, 02-05, 02-06, 02-07]
autonomous: false
requirements: [ONBR-01, ONBR-02, ONBR-03, ONBR-04, ONBR-05, ONBR-06, APPR-01, APPR-02]
files_modified_estimate:
  - dashboard/migrations/012-create-tuning-samples-v1-2026-04-27.sql
  - dashboard/migrations/013-create-settings-v1-2026-04-27.sql
  - dashboard/lib/auth/password.ts
  - dashboard/lib/queries-tuning.ts
  - dashboard/lib/queries-settings.ts
  - dashboard/lib/onboarding/live-gate.ts
  - dashboard/app/api/onboarding/admin/route.ts
  - dashboard/app/api/onboarding/email/route.ts
  - dashboard/app/api/onboarding/status/route.ts
  - dashboard/app/api/onboarding/notifications/route.ts
  - dashboard/app/api/onboarding/live-gate/route.ts
  - dashboard/app/api/tuning/samples/route.ts
  - dashboard/app/api/tuning/ratings/route.ts
  - dashboard/app/api/tuning/generate-sample/route.ts
  - n8n/workflows/12-tuning-sample-generate.json
---

<rescope_note>
**THIS IS A STUB. DO NOT EXECUTE.**

Captures shape and surfaces decisions for plan 02-08. Final stub
of the Phase 2 set; with this written, the full Phase 2 decision
surface is visible.

See `02-CONTEXT-ADDENDUM-v2-2026-04-27.md` for D-25..D-N. Original
02-CONTEXT.md decisions D-12..D-16 (staged-async, tuning, live-gate,
state machine) remain in force.
</rescope_note>

<changes_from_v1>

1. **Already shipped (no work in 02-08-v2):**
   - Queue API: `GET /api/drafts`, `GET /api/drafts/:id`, approve,
     reject, edit, retry — all live at `app/api/drafts/*`
   - `mailbox.onboarding` table with seeded `pending_admin` row
     (02-02-v2 migration 006)
   - `mailbox.persona` table (02-02-v2 migration 005)
   - `dashboard/lib/queries-onboarding.ts` with `getOnboarding`,
     `setStage`, `setAdmin`, `setEmail`, `isLive` (02-02-v2)
   - `dashboard/lib/queries-persona.ts` (02-02-v2)
   - `Onboarding`, `OnboardingStage`, `Persona` TypeScript types
     in `dashboard/lib/types.ts` (02-02-v2)
   - 6 D-16 stages enforced via CHECK constraint
     (02-02-v2 migration 006)

2. **File locations**: v1's Express routes become App Router files.
   Auth helper `lib/auth/password.ts` is new and self-contained
   (Node `crypto.scrypt`).

3. **Tuning samples table**: NOT in 02-02-v2; needs forward
   migration 012 in this plan. Schema per v1 spec
   (`inbox_message_id`, `draft_text`, `draft_source`, `category`,
   `confidence`, `rating`, `rated_at`).

4. **Settings table**: NOT in 02-02-v2; needs forward migration
   013. Schema: `id`, `customer_key`, `queue_threshold INTEGER`,
   `digest_email TEXT`, `created_at`, `updated_at`. Single-row-per-
   customer pattern matching `persona` and `onboarding`.

5. **Queue API gap-filling**: v1 specifies `X-Mailbox-Security:
   lan-trust-phase-2` response header on all queue routes plus
   pagination + status filter on `/api/drafts`. Phase 1's existing
   `/api/drafts` route doesn't have these. v2-stub note: defer
   the gap-filling to a stretch task in the full v2 plan; not
   strictly required for onboarding to work end-to-end.

</changes_from_v1>

<decisions_to_resolve>

**D-46 — Real-time updates: WebSocket vs polling**

v1 specifies WebSocket broadcasts on queue changes
(`queue.inserted`, `queue.updated`, `queue.removed`) and onboarding
state transitions. Next.js 14 App Router doesn't have first-class
WebSocket support — requires either a custom server (giving up
Vercel/serverless deploy paths) or a separate WS server in the
container.

For Phase 2 single-tenant on the Jetson:

- (a) Keep WebSocket. Add `ws` server inside the Next.js custom
  server. Tightly coupled to deploy.
- (b) Use Server-Sent Events (SSE) at
  `GET /dashboard/api/onboarding/events`. Native to Next.js
  App Router via `Response` with `text/event-stream`. Browser-
  native (no client library). One-way broadcast, fits the use case.
- (c) Drop real-time entirely. Frontend polls `GET /api/onboarding/
  status` every 2 seconds during onboarding, every 10 seconds in
  steady state. Less elegant but trivially simple.

(b) is the goldilocks: real-time updates without WebSocket complexity,
works in stock Next.js, browser-native EventSource API.

**Decision:** **(b) — SSE.** `GET /dashboard/api/onboarding/events`
streams server-sent events on stage transitions, ingest progress
updates, and tuning rating advances. Same endpoint pattern can serve
queue update events later if needed. Polling stays as a fallback for
the queue list (already shipped, works fine).

Rejected: WebSocket (complexity vs benefit at single-tenant);
polling-only (loses ingest progress smoothness during onboarding).

**D-47 — IMAP credentials entry UX**

The deferred decision from D-27. Where does the operator's IMAP/
SMTP credential entry happen?

- (a) Dashboard wizard collects credentials, calls n8n REST API
  to create credentials in n8n's encrypted store. Fully automated.
- (b) Operator enters credentials directly in n8n's web UI during
  white-glove onboarding. Dashboard wizard only collects email
  *address* and the credentials are configured separately.
- (c) Hybrid: Gmail OAuth2 happens via dashboard (redirect flow);
  manual IMAP/SMTP entry happens in n8n UI.

(a) means implementing n8n's credential REST API in 02-08 +
handling OAuth2 redirect flow + handling manual cred input safely.
Substantial work. (b) is what white-glove onboarding actually looks
like in practice (you, Dustin, configure n8n during the customer
handoff call).

**Decision:** **(b) for Phase 2.** Dashboard's `POST /api/onboarding/
email` accepts `{ email_address }` only (the address, not credentials).
Operator (you) configures n8n credentials directly during the
white-glove onboarding call. After credentials are configured in
n8n, the operator manually advances onboarding stage via dashboard
button: `POST /api/onboarding/email/confirm` advances stage to
`ingesting`.

This honors the white-glove model: every onboarding has a real
human (you) walking the customer through it. Adding credential-
entry UX automation is over-engineered for that workflow. Re-visit
in Phase 3+ if onboarding becomes self-serve.

The wizard does still validate the email address format and tests
basic IMAP connectivity (`POST /api/onboarding/email/test` — pings
the IMAP server) so the customer knows they entered a working
address before you, the operator, configure n8n.

Rejected: (a) full automation (over-engineered for white-glove);
(c) split flow (more code paths, no real benefit since you're on
the call anyway).

**D-48 — Tuning sample generation: synchronous or async**

v1 spec'd 20 tuning samples generated by n8n workflow `12-tuning-
sample-generate`. Per D-32, classification + drafting are blocked
by the live-gate during onboarding. The tuning samples need to
come from somewhere — they bypass the gate by being explicitly
generated.

The flow is: operator clicks "Generate samples" → workflow draws
20 representative inbound emails from the ingested
`inbox_messages` rows (where `direction='inbound'`, per D-38) →
runs each through the drafting pipeline (calling 02-07's drafting
endpoints with a TUNING flag that bypasses live-gate) → writes
results to `mailbox.tuning_samples`.

**Decision:** Generation is async via n8n workflow `12-tuning-
sample-generate`. SSE event stream notifies the dashboard when
each sample is ready (1-of-20, 2-of-20, etc.) so the operator can
start rating before all 20 are generated.

The TUNING bypass: drafting endpoints (`/api/internal/draft-cloud`,
plus the n8n-side draft workflows from 02-07) accept an optional
`{ tuning: true }` flag in the request. When set, drafting proceeds
even when onboarding stage is not `live`, AND the result writes to
`tuning_samples` instead of `drafts`. The classification path itself
runs unconditionally (per D-32) — only drafting is gated.

Rejected: synchronous generation (blocks UI for 60+ seconds);
generating tuning samples ahead of live-gate (timing — samples need
to be drafted with the ACTUAL live persona, which only exists after
02-06's extraction completes).

**D-49 — Live-gate enforcement boundary**

The live-gate concept appears across plans (D-32 from 02-04,
referenced in 02-07, defined here). Where exactly does it run?

- (a) Each plan that touches drafting checks the gate independently
  (read `onboarding.stage` directly via SQL).
- (b) Centralize in `dashboard/lib/onboarding/live-gate.ts` exposing
  `isLive(): Promise<boolean>` and a wrapper
  `enforceLiveGate(allowTuning: boolean): Promise<void>` that
  throws if not live and not in tuning mode.
- (c) Centralize as Next.js middleware that runs on `/api/internal/
  draft-*` routes.

(b) is the cleanest. (c) couples too tightly to URL routing and
doesn't help the n8n workflow side which calls Postgres directly.

**Decision:** **(b)**. `dashboard/lib/onboarding/live-gate.ts`
exports both functions. The n8n workflow side queries
`mailbox.onboarding` directly for the stage value (per D-26 — n8n
writes/reads Postgres directly for high-frequency operations).
Both paths consult the same data; the function is the canonical
TypeScript-side check.

Document the gate logic in this addendum (and in
`lib/onboarding/live-gate.ts` doc-comment) so n8n workflow
implementers don't re-derive the rule.

The rule: drafting is allowed iff `onboarding.stage = 'live'` OR
the request carries `tuning: true`. Classification + log-writing
+ inbox_messages insertion run unconditionally regardless.

Rejected: per-plan gate checks (drift); middleware (URL-coupled).

</decisions_to_resolve>

<dependencies_on_other_stubs>

- **02-03 (IMAP ingestion)**: 02-08's email-confirm API advances
  onboarding to `ingesting` stage. The IMAP workflow from 02-03
  already runs unconditionally once configured in n8n; the stage
  is just for dashboard UI to display "ingesting in progress."
- **02-05 (RAG)**: 02-08's email-confirm triggers `06-rag-ingest-
  sent-history` workflow (per 02-05 stub). 02-08 watches for the
  workflow to complete (via Postgres counter on `onboarding.
  ingest_progress_done == ingest_progress_total`) and advances
  stage to `pending_tuning`.
- **02-06 (persona)**: 02-08's flow waits for sent-history ingest,
  then triggers `09-persona-extract-trigger` (per 02-06 stub).
  After persona is populated, advances to `pending_tuning`.
- **02-07 (drafting)**: 02-08's tuning-sample workflow uses 02-07's
  drafting endpoints with the `tuning: true` bypass flag (per D-48).
  02-07's `assembleCloudPrompt()` (D-45) runs unchanged for tuning
  samples since the input is real persona + real RAG + real inbound.

</dependencies_on_other_stubs>

<tasks_outline>

Sketch only; not executable.

1. Add migration 012: CREATE TABLE mailbox.tuning_samples (per v1
   spec); CHECK constraint on `rating` and `category`
2. Add migration 013: CREATE TABLE mailbox.settings (per v1 spec);
   single-row-per-customer pattern
3. Create `dashboard/lib/auth/password.ts` — Node `crypto.scrypt`
   wrapper with timing-safe verify
4. Create `dashboard/lib/queries-tuning.ts` — `listSamples`,
   `getSample`, `submitRating`, `getRatingProgress`
5. Create `dashboard/lib/queries-settings.ts` — `getSettings`,
   `upsertSettings`
6. Create `dashboard/lib/onboarding/live-gate.ts` — `isLive`,
   `enforceLiveGate(allowTuning)` (D-49)
7. Update `dashboard/lib/types.ts` — add `TuningSample`,
   `TuningRating`, `Settings` interfaces
8. Create `dashboard/app/api/onboarding/admin/route.ts` —
   POST validates password >= 12 chars, hashes via lib/auth, writes,
   advances stage to `pending_email`
9. Create `dashboard/app/api/onboarding/email/route.ts` — POST
   accepts `{ email_address }`, validates format, writes to onboarding
   row, returns 200; does NOT advance stage
10. Create `dashboard/app/api/onboarding/email/test/route.ts` —
    POST tests IMAP connectivity to the configured address (via
    a server-side IMAP probe — node-imap or equivalent), returns
    success/failure
11. Create `dashboard/app/api/onboarding/email/confirm/route.ts` —
    POST advances stage to `ingesting` AFTER operator has manually
    configured n8n credentials (D-47)
12. Create `dashboard/app/api/onboarding/status/route.ts` — GET
    returns onboarding row + computed progress fields
13. Create `dashboard/app/api/onboarding/events/route.ts` — SSE
    stream of stage/progress changes (D-46). Uses Postgres LISTEN/
    NOTIFY or polling-with-suspense to detect changes
14. Create `dashboard/app/api/onboarding/notifications/route.ts` —
    POST writes to settings table; GET reads
15. Create `dashboard/app/api/onboarding/live-gate/route.ts` —
    GET returns `{ live: boolean }` (consumed by 02-04 per D-49
    cross-reference; n8n workflows query directly for performance)
16. Create `dashboard/app/api/tuning/samples/route.ts` — GET lists
    20 tuning samples with their current rating state
17. Create `dashboard/app/api/tuning/ratings/route.ts` — POST
    accepts `{ sample_id, rating: 'good'|'wrong'|'edit', edited_text? }`,
    advances onboarding to `live` when all 20 are rated (D-15)
18. Create `dashboard/app/api/tuning/generate-sample/route.ts` —
    POST triggers `12-tuning-sample-generate` workflow
19. Create `n8n/workflows/12-tuning-sample-generate.json`:
    Webhook trigger → SELECT 20 representative inbox_messages →
    loop → call drafting endpoints with `tuning: true` →
    INSERT into tuning_samples → emit SSE-via-NOTIFY for each
20. Smoke test: full onboarding flow end-to-end. Admin creation →
    email entry → manual n8n cred config → ingest progress →
    persona extract → 20 tuning samples → rate all 20 → live.
    Verify each stage transition fires SSE event. Verify live-gate
    blocks drafting before stage='live'. Verify TUNING bypass works.

</tasks_outline>

<deferred_items>

- WebSocket-based real-time (per D-46) — Phase 3+ if SSE proves
  insufficient
- Self-serve onboarding (no operator on the call) — Phase 3+ via
  D-47 path (a)
- Queue API gap-filling (X-Mailbox-Security header, status filter,
  pagination) — fold into a separate small plan or stretch task
  in 02-08-v2 full plan
- Operator login + auth on queue routes — Phase 4 (DASH-02)
- Multi-customer onboarding flows — Phase 3+

</deferred_items>

<scope_addendum_cpg_scrub date="2026-05-08">

**Phase 2 of CPG-scrub folds into 02-08.** When this stub is promoted
to a full v2 plan, industry/business-description capture MUST be in
scope. Without it, every fresh appliance ships with an empty
`business_description` until the operator (Dustin) manually populates
`mailbox.persona.statistical_markers.business_description` post-install
— exactly the manual step Phase 1 was meant to remove.

Background: Phase 1 of CPG-scrub (commit `2bdba13`, 2026-05-08) added
`business_description` to `PersonaContext` and templated it into both
the classify and draft prompts. The persona FALLBACK is now industry-
neutral; the operator override is what carries the brand framing.
M1 + M2 had their overrides set out-of-band ahead of the deploy
(`small-batch CPG (gummies + functional confections) operator` and
`B2B tech / dev-tools company (Staqs builds AI agent infrastructure
for small businesses)` respectively). Customer #3 onward should not
require an out-of-band write — onboarding owns it.

**Requirements registered against this stub:**

- `ONBR-07` (new): Onboarding captures `business_description` from
  the operator and writes it to
  `mailbox.persona.statistical_markers.business_description` before
  stage advances past `pending_admin`. (Add to REQUIREMENTS.md when
  the stub is promoted.)

- `ONBR-08` (new): Onboarding captures `operator_brand` (the company /
  brand name used in draft framing — currently the `brand` field on
  PersonaContext) at the same step. Without this, the prompt template
  falls back to "a small business operator" / unnamed brand; we want
  the named brand from day one.

**Wizard placement:**

New step between `pending_admin` (admin account creation) and
`pending_email` (email address entry). Single screen, two text fields:

1. `operator_brand` (e.g., "Heron Labs", "Staqs") — short, used in
   prompt as `{brand}`.
2. `business_description` (1-2 sentences, e.g., "B2B tech / dev-tools
   company building AI agent infrastructure for small businesses")
   — used in prompt as `{description}`.

Persistence: upsert into `mailbox.persona` (already-seeded row from
02-02-v2 migration 005). Specifically:
- `persona.statistical_markers.operator_brand` ← `operator_brand`
- `persona.statistical_markers.business_description` ← `business_description`
- `persona.persona_key` stays at the existing `customer_key` value
  (single-customer-per-appliance — no new persona rows from this).

**API surface:**

New route to add to the tasks outline (between current tasks 8 and 9):

- `POST /api/onboarding/business`: body
  `{ operator_brand: string (1..80 chars), business_description: string (1..400 chars) }`,
  upserts persona row, advances onboarding stage from `pending_admin`
  to `pending_email`. Validate via zod schema in
  `lib/schemas/onboarding.ts`. Source-of-truth for persona writes
  remains `lib/queries-persona.ts` (02-02-v2) — add `setBusinessFraming`
  helper if one doesn't already exist.

**State machine impact:**

Two options for the new step:

- (a) Insert a new stage `pending_business` between `pending_admin`
  and `pending_email`. Adds a 7th stage to the D-16 enum + CHECK
  constraint (migration 006 amendment).
- (b) Roll business-framing capture into the `pending_admin` step
  UI but keep the stage enum unchanged — admin form has 4 fields
  (username, password, brand, description), all submitted together
  by `POST /api/onboarding/admin`. Stage flips straight to
  `pending_email`.

**Recommendation: (b).** Reasons: keeps the D-16 enum stable (no new
migration, no n8n / dashboard live-gate code paths to thread a 7th
stage through); the white-glove install (D-47) means there's no
recoverability gain from a separate stage — operator sets it all in
one sitting. The `POST /api/onboarding/admin` schema gains two fields;
the route's persona-write happens in the same transaction as the
admin-creation write.

**Open question for the full v2 plan author:** how does the wizard
present "business description" — free-text? a curated dropdown of
common verticals plus "other"? a few suggestion chips? Free-text is
simplest and matches what Phase 1 wired (the prompt template just
interpolates the string). Curated verticals would be premature
without eval data — defer to Phase 4 of CPG-scrub
(per-industry category-definition tuning) which the original handoff
flagged as "deferred until eval data demands it."

**Test additions:**

- Unit: `setBusinessFraming` upserts both fields to
  `mailbox.persona.statistical_markers.{operator_brand, business_description}`
- Route: `POST /api/onboarding/admin` with the new fields rejects
  empty `business_description`, accepts trimmed strings, and after
  success `getPersonaContext` returns the supplied values
- Integration: full onboarding smoke (task 20 of `<tasks_outline>`)
  starts with brand+description input; verify the LIVE classify
  prompt for the first inbound email contains the operator-supplied
  brand and description (not the generic "a small business operator"
  fallback)

</scope_addendum_cpg_scrub>
