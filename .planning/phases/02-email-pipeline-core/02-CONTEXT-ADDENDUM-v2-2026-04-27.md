---
phase: 2
addendum: v2-pivot
created: 2026-04-27
references: 02-CONTEXT.md (v1 decisions D-01..D-24)
---

# Phase 2 Context Addendum — Architectural Pivot Decisions

This addendum captures decisions that emerged during the 2026-04-27
re-scoping of Phase 2 plans against the Next.js + n8n architecture
adopted in the ADR (`.planning/STATE.md` "Architectural Decision
Record: Dashboard Stack Pivot").

Decisions D-01..D-24 in `02-CONTEXT.md` remain in force unless
explicitly superseded here. Decisions below are numbered D-25 onward
and are referenced from the v2 stub plans
(`02-03..08-*-PLAN-v2-2026-04-27-STUB.md`).

---

## Cross-Plan Architectural Decisions

### D-25 — Threading header storage

**Plan:** 02-03 (IMAP ingestion)

`mailbox.inbox_messages` (kept as canonical from Phase 1 sub-project,
per 02-02-v2) does not yet carry `in_reply_to` or `references`
headers. Required by FR-MAIL-04 for SMTP reply threading.

**Decision:** ALTER TABLE inbox_messages ADD COLUMN in_reply_to TEXT,
references TEXT via a new forward migration (likely 009). Mirrors the
columns already added to `mailbox.drafts` in 02-02-v2 migration 003.

Rejected: separate `headers JSONB` column (more flexible but harder
to query); storing on `drafts` only (couples ingestion to drafts).

### D-26 — n8n → Postgres write path

**Plan:** 02-03 (IMAP ingestion); pattern applies to all n8n workflow
writes throughout Phase 2.

**Decision:** n8n Postgres node directly INSERTs to `mailbox.*`
tables for high-frequency append-only writes (`inbox_messages`,
`classification_log`). Reserve Next.js API route writes for
state-mutating operations that need cross-table consistency or
trigger downstream effects (already shipped as `app/api/drafts/*` for
approve/reject/edit/retry).

n8n holds Postgres credentials in its encrypted credential store. No
plaintext credentials in workflow JSON files committed to git.

Rejected: routing all writes through Next.js (adds network hop and
auth surface for high-frequency ingestion).

### D-27 — IMAP credentials entry UX

**Plan:** 02-08 (onboarding wizard)

n8n stores Gmail OAuth2 / IMAP credentials in its encrypted store.
The UX for *entering* those credentials is the open question.

**Decision:** Defer to 02-08-v2 stub. The credentials-by-name pattern
in n8n is unchanged from v1; 02-03 reads them by name. 02-08 will
specify whether the operator enters them via dashboard wizard
(automated, requires n8n REST API integration) or manually via SSH
during white-glove onboarding (less automated, more reliable).

### D-28 — Watchdog failure notification

**Plan:** 02-03 (IMAP watchdog)

v1 specified emailing the operator after 2 consecutive watchdog
restart failures. Email path uses customer SMTP — the same account
being watched, creating a circular dependency if SMTP itself is dead.

**Decision (Phase 2):** Skip operator email entirely. Surface
watchdog failures only on the dashboard status page (Phase 4
deliverable). Watchdog continues to log failures to Postgres for
audit.

**Decision (deferred to Phase 3):** Add operator notification with
the auto-send/notifications work (NOTF-01, NOTF-02) — at that point
notification infrastructure exists and the circular dependency can
be addressed properly (e.g. via a separate transactional SMTP
provider or webhook).

Rejected: adding a third-party transactional SMTP dependency in
Phase 2 just for watchdog alerts.

---

## Format

Each new decision adds a `### D-NN — Title` section above this line,
with at minimum:

- **Plan:** which v2 stub raised it
- A 1-3 paragraph explanation
- The decision in **bold** below
- "Rejected:" line(s) for alternatives that were considered

When a stub gets promoted to a full v2 plan, the cross-references in
that plan should cite both `02-CONTEXT.md` (D-01..D-24) and this
addendum (D-25+).

### D-29 — Ollama invocation path from n8n

**Plan:** 02-04 (classification + routing)

n8n can invoke Ollama via two paths: built-in Ollama Model node
(LangChain-style), or HTTP Request node calling
`http://ollama:11434/api/generate` directly. The choice matters
because the classification prompt is also imported by the
`heron-labs-score.mjs` scoring script that proves MAIL-08 accuracy.
If the prompt drifts between live workflow and scoring script,
accuracy regressions become invisible.

**Decision:** HTTP Request node. The canonical prompt lives at
`dashboard/lib/classification/prompt.ts` and is exposed read-only at
`GET /dashboard/api/internal/classification-prompt`. The n8n workflow
fetches the prompt at run-time and passes it to the Ollama HTTP API.
The scoring script imports the same TypeScript module directly. One
canonical source, drift impossible.

Rejected: built-in Ollama Model node (CLAUDE.md's preferred path),
because for classification specifically the drift risk silently
degrades accuracy. Other workflows (drafting in 02-07) may use the
built-in node where prompts don't have offline scoring counterparts.

### D-30 — Routing decision location

**Plan:** 02-04 (classification + routing)

The local-vs-cloud routing decision is a pure function of category +
confidence threshold (D-01, D-02). Could live in n8n IF node or as a
centralized TypeScript function exposed via API.

**Decision:** Keep routing in the n8n workflow's IF node. Document
the rule in this addendum so it's discoverable without opening
workflow JSON: route to local Qwen3 if `category IN
('reorder','scheduling','follow_up','internal') AND confidence >=
ROUTING_LOCAL_CONFIDENCE_FLOOR (default 0.75)`; route to cloud
Claude Haiku otherwise. Spam/marketing handled per D-21/D-31; never
routes to drafting.

Rejected: centralizing routing in
`dashboard/lib/classification/route.ts` exposed as an API route —
adds a network hop on every email for negligible benefit at single-
tenant Phase 2 scope.

### D-31 — Spam/marketing storage

**Plan:** 02-04 (classification + routing)

D-21 (v1) says spam/marketing emails skip the queue. v2's queue is
`mailbox.drafts` (not `draft_queue`). Same rule applies — spam
emails get a `classification_log` row but no `drafts` row.

**Decision:** Spam emails ARE retained in `mailbox.inbox_messages`
(the storage of raw inbound, immutable). The `drafts` row is what's
skipped. Dashboard `/api/drafts` JOIN already returns only inbox
rows that have a corresponding draft, so spam never appears in the
queue UI. Audit trail preserved in `inbox_messages` +
`classification_log`; storage cost trivial on NVMe.

Rejected: deleting spam from `inbox_messages` — irreversibly loses
ingestion history and the corpus for future ML retraining.

### D-32 — `auto_send_blocked` separation of concerns

**Plan:** 02-04 (classification + routing); affects Phase 3.

D-04 (v1) says `escalate` category sets `auto_send_blocked=true` and
"no future auto-send rule (Phase 3) can fire" on it. Clarifying the
v2 boundary:

**Decision:** 02-04 is responsible for SETTING `auto_send_blocked=true`
on INSERT to `mailbox.drafts` when category is `escalate`. ENFORCEMENT
of the flag (preventing auto-send) is Phase 3's responsibility, since
auto-send rules don't exist in Phase 2. 02-04's smoke test verifies
the flag is set correctly; it does NOT verify enforcement.

Not really a decision needing resolution — flagging the boundary so
Phase 3 implementers don't assume enforcement exists.

### D-33 — Qdrant collection topology

**Plan:** 02-05 (RAG ingest + retrieval)

Single tenant in Phase 2; multi-tenant on the roadmap. Choosing
between one collection with payload filters vs per-source or
per-customer collections.

**Decision:** Single Qdrant collection `mailbox_rag` for sent emails,
inbound emails, and uploaded documents. Payload-indexed fields
`source` ('sent_email' | 'inbound_email' | 'document'), `source_id`,
and `category` (denormalized from classification when source is
'inbound_email'). Filters at query time keep retrieval scoped.

Multi-tenancy added in Phase 3+ via a `customer_key` payload field
(no schema migration needed at the Qdrant level — Qdrant payloads
are schemaless). Phase 2 implicitly single-customer.

Rejected: per-source collections (over-engineered for one tenant);
per-customer collections (premature multi-tenancy).

### D-34 — Chunking strategy per source

**Plan:** 02-05 (RAG ingest + retrieval)

nomic-embed-text v1.5 has a 2K-token context window. Most CPG
operator email is short (a few hundred words = 1 chunk works).
Long documents and edge-case long emails need splitting.

**Decision:** Soft cap of 1500 tokens per chunk (well under 2K
ceiling). Single `chunk()` function at `dashboard/lib/rag/chunk.ts`
parameterized by source type:
- `source='sent_email'` or `'inbound_email'`: if under 1500 tokens,
  emit 1 chunk; otherwise paragraph-split
- `source='document'`: always paragraph-split, with `meta.location`
  payload field carrying page number (PDF) or row number (CSV) or
  paragraph index (DOCX)

Rejected: per-email-always (truncates long emails silently);
per-paragraph-always (loses cross-paragraph context for short
emails — most operator email).

### D-35 — Document upload format support

**Plan:** 02-05 (RAG ingest + retrieval); affects 02-08 (onboarding).

CPG operators commonly have product catalogs in PDF. Node-side PDF
parsing libraries pull binary deps that build flakily on ARM64.

**Decision:** Support PDF, DOCX, and CSV in Phase 2. Use system-
installed `pdftotext` (from `poppler-utils`, available in JetPack
6 base) as the PDF extraction path — invoke it via Node `child_process`
from `dashboard/lib/rag/extract.ts`. DOCX uses `mammoth` npm package.
CSV uses `papaparse` (already a stack dependency).

Avoids the brittle Node PDF parser ecosystem on ARM64 entirely. The
onboarding wizard accepts all three formats without operator-side
file conversion friction.

Rejected: deferring PDF to Phase 2.5+ (real onboarding friction —
most catalogs are PDFs); using `pdf-parse` or similar Node library
(binary dep flakiness on ARM64).

### D-36 — Embedding endpoint location

**Plan:** 02-05 (RAG); affects 02-07 (drafting).

Two callers need embeddings: bulk sent-history ingest in n8n
workflow (thousands of chunks) and drafting context-build in
TypeScript (single chunk per draft).

**Decision:** Single canonical embedding implementation at
`dashboard/lib/rag/embed.ts`. Two invocation paths:
- n8n bulk ingest workflow calls `http://ollama:11434/api/embeddings`
  directly (skip the Next.js round-trip for high-volume bulk work)
- Drafting (02-07) and document upload (02-05 single-doc path) call
  the TypeScript helper directly via `import`

If a future plan needs n8n-side single-shot embedding it can call
`POST /dashboard/api/internal/rag-embed` (not implemented in 02-05;
add when the use case appears).

Rejected: route everything through Next.js (slow for bulk ingest);
duplicate the embedding logic in n8n + TypeScript (drift risk on
prompts that aren't single-token-per-call).

### D-37 — Top-K retrieval API contract

**Plan:** 02-05 (RAG); contract consumed by 02-07 (drafting).

02-07's drafting context builder needs top-K relevant chunks.
Stable API contract decoupled from RAG internals.

**Decision:** Expose at `POST /dashboard/api/internal/rag-search`.

Request: `{ query: string, category?: ClassificationCategory,
            k?: number = 3 }`
Response: `{ results: [{ text, score, source, source_id, meta }] }`

Threshold filtering (RAG-05: 0.72) applied server-side before
returning. Below-threshold results are silently dropped, not
returned with a flag. Empty `results` is a valid response and means
"no relevant context found."

Rejected: have 02-07 import `lib/rag/client.ts` directly. Tighter
coupling; harder to swap retrieval backends later (e.g. if we move
from Qdrant to pgvector). The API boundary is testable in isolation.

### D-38 — Sent-history storage table

**Plan:** 02-06 (persona); 02-05 (RAG ingest writes here); affects
schema across Phase 2.

The forced-to-ground question from 02-05's stub: where do IMAP
`Sent Mail` rows land during onboarding ingestion? The existing
`mailbox.sent_history` table (from 02-02-v2 migration 004) is
shaped for *post-approval Claude drafts* (carries `draft_original`,
`draft_sent`, `draft_source` columns) — wrong shape for backfilled
operator-written email.

**Decision:** ALTER `mailbox.inbox_messages` to add a `direction`
column (`'inbound' | 'sent'`, default `'inbound'`) via forward
migration 010. Both inbound AND sent operator-written email live
in this table. The table-name awkwardness ("inbox" containing sent
messages) is real but cheap to fix later via a rename migration.

`mailbox.sent_history` keeps its v1 semantics: post-approval
Claude-drafted sends. Persona reads from `inbox_messages WHERE
direction='sent'`. RAG reads from both via payload `source`.

The 6 existing inbox_messages rows are preserved with the DEFAULT
direction='inbound'.

Rejected: separate `mailbox.sent_emails` table (over-decomposed —
three sent-related tables); reusing `mailbox.sent_history` for
backfilled mail (semantic drift; columns don't fit operator-written
historical email).

### D-39 — Persona extraction compute location

**Plan:** 02-06 (persona)

Statistical markers + per-category exemplar selection across 6
months of sent mail can take 30+ seconds. Three options for where
the work runs:

- API route blocks: hits Next.js default 60s timeout risk
- Background job table: premature complexity at single-tenant scale
- n8n orchestrates, calls TypeScript helpers via API for math

**Decision:** n8n orchestrates. Workflow `09-persona-extract-trigger`
fetches sent emails, pairs with inbounds, batch-classifies unpaired
(per D-40), then POSTs the corpus to a new internal Next.js endpoint
`POST /dashboard/api/internal/persona-build` which runs the pure-TS
math and returns the built persona JSON. n8n persists the result
via `POST /dashboard/api/persona/extract` which calls
`upsertPersona()` from `lib/queries-persona.ts`.

n8n owns orchestration and long-running flow control; Next.js owns
the math (testable, typechecked) and the persistence boundary. No
duplicated logic.

Rejected: API-route-blocks (timeout risk); background-job table
(premature complexity for a once-at-onboarding + monthly-refresh
operation).

### D-40 — Categorizing historical sent emails

**Plan:** 02-06 (persona); affects 02-05 (sent-history ingest).

Per-category persona exemplars (D-09: 3-5 per category) require
sent emails grouped by category. For *new* drafts post-onboarding,
the inbound's classification flows through to sent_history via
the approve-flow. For *backfilled* historical sent emails (6
months of operator email pre-appliance), there's no inbound
classification.

**Decision:** Pair historical sent with inbound via `thread_id` /
`in_reply_to` where possible (the inbound is in the same 6-month
ingest sweep). When pairing succeeds, classify the inbound and
inherit the category. When pairing fails (no matching inbound,
missing thread headers), the sent email contributes to *statistical
markers only*, not category exemplars. Tuning samples in 02-08 fill
per-category gaps during white-glove handoff.

Implementation note: pairing happens during the 02-06 extract
workflow, not during 02-05 ingest — RAG indexing is category-
agnostic at retrieval time, so no need to spend ingest cycles on
classification.

Rejected: skip category-grouping entirely for backfilled email
(loses pairing data that mostly exists); classify all backfilled
sent mail at ingest time (slow, doesn't degrade gracefully when
threading metadata is missing).

### D-41 — Drafting prompt source-of-truth

**Plan:** 02-07 (draft generation)

Same anti-drift pattern as D-29 (classification prompt). Drafting
prompts are referenced by local Qwen3 path (n8n), cloud Haiku path
(via D-42), and potentially the 02-08 tuning UI for re-rendering
exemplar drafts.

**Decision:** Canonical builders at `dashboard/lib/drafting/prompt.ts`:
`buildSystemPrompt(persona)` and `buildUserPrompt(inbound, ragRefs,
categoryExemplars)`. Exposed via `POST /dashboard/api/internal/draft-
prompt` which takes a drafts row id and returns rendered system +
user prompts ready for LLM invocation. Single source of truth, no
drift between local and cloud, no drift between live workflow and
tuning UI.

POST not GET because building requires loading persona JSON, RAG
context, and exemplars — inputs don't fit a query string and the
operation has side effects (RAG search) that change cache semantics.

Rejected: copy prompts into both workflow JSONs (drift inevitable);
different prompts for local vs cloud (defeats v1's "draft_source
is the only difference" guarantee).

### D-42 — Anthropic API invocation path

**Plan:** 02-07 (draft generation)

Unlike Ollama (D-29) where the HTTP node won, Anthropic warrants
different treatment: SDK provides retry semantics, error typing,
streaming support, and prompt caching that re-implementing in n8n
expression language is painful.

**Decision:** Cloud drafting goes through Next.js. Endpoint
`POST /dashboard/api/internal/draft-cloud` accepts `{ drafts_id,
system, user }`, calls Anthropic SDK, returns `{ draft_text,
input_tokens, output_tokens, cost_usd, model }`. n8n's job: fetch
prompt (D-41), call this endpoint, persist response to drafts row.

Cost computation lives inside the cloud endpoint via
`dashboard/lib/drafting/cost.ts` (fulfills D-22). The n8n workflow
doesn't need pricing constants.

The extra network hop (n8n → Next.js → Anthropic) adds <10ms; the
Anthropic call itself is 500ms-3s. Negligible cost for clear
ergonomic and observability wins.

Rejected: HTTP node directly to Anthropic (loses SDK ergonomics,
duplicates retry logic in n8n).

### D-43 — Approve flow → SMTP send trigger

**Plan:** 02-07 (draft generation + SMTP send)

The existing `app/api/drafts/[id]/approve/route.ts` (Phase 1) needs
to trigger SMTP send when the operator clicks Approve.

**Decision:** Approve API directly invokes
`dashboard/lib/smtp/send.ts` synchronously. SMTP send is in the
critical path of the Approve action. n8n is NOT involved in the
post-approve send path.

Send code reads thread headers from the drafts row (denormalized in
02-02-v2 migration 003), builds the email with `In-Reply-To` /
`References` per D-24, sends via `nodemailer`. On success: row moves
to `mailbox.sent_history` (per D-19). On failure: status='failed',
error_message populated for retry-via-UI.

Clear separation of concerns by workflow phase:
- n8n owns ingestion, classification, drafting, retry
- Next.js owns approval, sending, reject-archival

For Phase 2 single-tenant scale, Gmail SMTP latency (200-500ms
typical) blocking the approve API is acceptable and produces clear
inline error reporting. Move to async send when multi-tenant or
high-volume justifies it.

Note: v1's `n8n/workflows/11-send-smtp-sub.json` is REMOVED from
the file list. The send path lives entirely in TypeScript.

Rejected: async via n8n webhook (over-engineered for single-tenant;
adds a second failure surface).

### D-44 — Cloud retry worker

**Plan:** 02-07 (draft generation)

D-03 (graceful cloud degradation): when Anthropic is unreachable,
row enters `status='awaiting_cloud'` with `draft_original=NULL`. A
worker re-drives these rows.

**Decision:** Keep v1 design. Workflow `10-cloud-retry-worker` runs
every 5 minutes, queries for `awaiting_cloud` rows, retries the
cloud-draft endpoint (D-42), bumps `retry_count`. After 10 failures,
move row to `mailbox.rejected_history` with note "exceeded retry
budget."

Adds migration 011: ALTER TABLE mailbox.drafts ADD COLUMN
retry_count INTEGER NOT NULL DEFAULT 0.

Per D-26, the retry worker writes directly to Postgres for the
counter increment but invokes the cloud-draft Next.js endpoint for
the actual retry attempt (per D-42).

Rejected: exponential backoff (more complex; 5-min cron is
sufficient for transient cloud issues at single-tenant scale);
unbounded retry (infinite-loop on permanently bad rows).

### D-45 — Egress inventory boundary

**Plan:** 02-07 (cloud drafting)

The threat model in v1 specifies that only persona profile + top-3
RAG refs + inbound email body leave the appliance per cloud draft.
This needs to be a testable boundary, not just a documented
intention — accidental broadening via code regression is the
expected failure mode.

**Decision:** Define an explicit allowlist in
`dashboard/lib/drafting/cloud.ts`. Function
`assembleCloudPrompt(draftsId)` returns a typed value whose interface
explicitly lists every field that goes to Anthropic. Adding a field
requires changing the interface; reviewers see the diff.

Test in `dashboard/lib/drafting/cloud.test.ts`: assert that the
JSON-stringified output of `assembleCloudPrompt()` against a fixture
contains no fields from a denylist (e.g. `'sent_history'`,
`'inbox_messages'` bulk arrays, `'persona.statistical_markers.
vocabulary_top_terms'` beyond top-N). Run as part of typecheck/test
pipeline.

This guards against the regression mode ("oh let's just include the
full persona for better results") that's invisible at code review
time without explicit guardrails.

Rejected: rely on inline doc strings and code review (regression
risk over time); send minimal data and have Anthropic re-fetch
(not architecturally possible — Anthropic doesn't have appliance
access).

### D-46 — Real-time updates: SSE over WebSocket

**Plan:** 02-08 (onboarding wizard)

v1 specifies WebSocket broadcasts for queue + onboarding state
changes. Next.js 14 App Router has no first-class WebSocket
support — would require a custom server (giving up Next.js'
deploy ergonomics) or a separate WS container.

**Decision:** Server-Sent Events (SSE). Endpoint
`GET /dashboard/api/onboarding/events` streams events on stage
transitions, ingest progress updates, and tuning-rating advances.
Native to Next.js via `Response` with `text/event-stream`. Browser-
native EventSource API on the client; no client library needed.
One-way broadcast fits the use case (server → client only).

Polling stays as the fallback for the queue list (already shipped
that way, works fine, no need to retrofit).

Rejected: WebSocket (complexity at single-tenant scale); polling-
only (loses ingest progress smoothness during onboarding).

### D-47 — IMAP credentials entry UX (white-glove)

**Plan:** 02-08 (onboarding wizard); resolves the deferred D-27.

Phase 2 onboarding is white-glove — every customer launch has the
operator (Dustin) on a call walking through setup. Building
self-serve credential-entry UX is work that solves a problem we
don't yet have.

**Decision:** Dashboard's `POST /api/onboarding/email` accepts
`{ email_address }` only — the address, not credentials. Operator
configures n8n credentials directly in n8n's web UI during the
white-glove call. After credentials are configured, the operator
clicks a dashboard button calling `POST /api/onboarding/email/
confirm` which advances onboarding stage to `ingesting`.

The wizard does provide `POST /api/onboarding/email/test` — pings
the IMAP server with the entered address to validate format +
basic connectivity. Customer sees "your email is reachable" before
the operator goes off-screen to configure n8n.

Re-visit when onboarding becomes self-serve (Phase 3+ via the path
(a) automation we rejected here).

Rejected: full automation via n8n REST credential API (over-engineered
for white-glove); split flow with OAuth automated + manual via n8n
UI (more code paths, no real benefit since operator is already on
the call).

### D-48 — Tuning sample generation: async with TUNING bypass

**Plan:** 02-08 (onboarding wizard)

Per D-32, drafting is blocked by the live-gate during onboarding.
But the 20 tuning samples (D-15) need real persona-grounded drafts
generated against real inbound emails — exactly the operation the
gate blocks.

**Decision:** Generation is async via n8n workflow `12-tuning-
sample-generate`. Operator clicks "Generate samples" → workflow
draws 20 representative inbound emails from `inbox_messages WHERE
direction='inbound'` (per D-38) → runs each through 02-07's
drafting endpoints with `{ tuning: true }` flag set → result writes
to `mailbox.tuning_samples` instead of `mailbox.drafts`. SSE event
fires for each sample as it completes (per D-46) so the operator
can begin rating before all 20 are ready.

The TUNING bypass: drafting endpoints accept an optional
`{ tuning: true }`. When set, drafting proceeds even when stage is
not `live`, AND the result writes to `tuning_samples`. The
classification path runs unconditionally regardless of TUNING flag
(per D-32). Only drafting is gated.

Rejected: synchronous generation (blocks UI 60+ seconds); generating
samples ahead of live-gate (timing — needs the actual extracted
persona, which only exists after 02-06 completes).

### D-49 — Live-gate enforcement boundary

**Plan:** 02-08 (defines); affects 02-04 (consumes), 02-07 (consumes).

The live-gate concept appears across plans (D-32, D-43, D-48). Where
exactly does the check happen?

**Decision:** Centralize in `dashboard/lib/onboarding/live-gate.ts`.
Exports:
- `isLive(): Promise<boolean>` — pure boolean check
- `enforceLiveGate(allowTuning: boolean): Promise<void>` — throws
  if not live and `allowTuning` is false

The n8n workflow side queries `mailbox.onboarding.stage` directly
via Postgres (per D-26). Both paths consult the same source of
truth.

The rule, documented here so n8n implementers don't re-derive it:
> Drafting (and only drafting) is allowed iff
> `onboarding.stage = 'live'` OR the request carries
> `tuning: true`. Classification, classification_log writes, and
> inbox_messages inserts run unconditionally regardless.

Also exposed via `GET /dashboard/api/onboarding/live-gate` returning
`{ live: boolean }` for n8n workflows that prefer the API
boundary over direct Postgres reads (slightly higher latency, but
some workflow steps benefit from the cache-friendly single-call
pattern).

Rejected: per-plan independent gate checks (drift over time);
Next.js middleware on `/api/internal/draft-*` URLs (URL-coupled,
doesn't help the n8n side).

---

## Post-2026-04-27 decisions (appended later)

### D-51 — Pub/Sub watch-renewal reverted; Schedule + Gmail node is the canonical ingestion path

**Plan:** 02-03 (IMAP/Gmail ingestion); affects every workflow that consumes `mailbox.inbox_messages`.

**Date logged:** 2026-05-01 (decision made 2026-04-30 evening).

DR-22 in the Phase 2 v1 context originally specified Gmail Pub/Sub push as the ingestion path, with a corresponding watch-renewal cron job tracked as **STAQPRO-115**. That ticket was **Cancelled 2026-04-30** ("DR-22 reverted per post-audit reviewer consensus"). Pub/Sub push is no longer the ingestion mechanism; the live workflow uses the n8n Gmail node + Schedule trigger (5-minute interval, per 02-04a's `minutesInterval: 5` fix), which has no trigger-death bug and no watch-renewal requirement.

**Decision:**

- **Ingestion path:** n8n Gmail node + Schedule trigger (every 5 minutes) → `Insert (skipOnConflict)` into `mailbox.inbox_messages` → `Execute Workflow` invoking the MailBOX-Classify sub-workflow with the new row id. Canonical workflow JSON: `n8n/workflows/01-email-pipeline-main.json`.
- **No Pub/Sub watch-renewal job.** STAQPRO-115 stays Cancelled. No `/webhook/mailbox-send` Pub/Sub-push handler is required for the ingestion path (the legacy Gmail Pub/Sub ingress endpoint and STAQPRO-108 are kept as a re-opened option for a future push-based reintroduction, but they are not the M2 path).
- **Webhook auth (STAQPRO-116)** is still required for any externally reachable `/webhook/*` endpoints. D-51 does not eliminate that requirement; it just means the ingestion path no longer creates one.

**Rationale:**

- Pub/Sub push adds operational complexity (watch-renewal cron, OIDC verification on every request, IP allowlisting, Pub/Sub project setup at the customer's GCP boundary) that isn't justified for the v1 polling latency budget (90s ingestion SLA per MAIL-01 — Schedule trigger at 5-min interval gives p95 ~5 min, which exceeds the SLA but is acceptable for v1; tighter polling is a Phase 3 concern).
- The reviewer consensus specifically noted that the legacy Gmail Pub/Sub ingress workflow (committed pre-rebase) was a one-off whose maintenance cost outweighed the latency win.
- Schedule + Gmail node is the path the operator (Dustin) has already debugged in production and is the path the corpus + scoring work in 02-04b validated against.

**Rejected alternatives:**

- Reduce poll interval to 1 minute (would meet the 90s SLA but multiplies Gmail API calls 5×, risks rate-limit territory on long onboarding ingest).
- Hybrid: Pub/Sub push for net-new email + Schedule trigger for catch-up (added complexity for marginal latency gain).

**Carry-forward:**

- 02-03 SUMMARY needs an addendum paragraph noting this revert (handled in same commit as this D-51 capture, per STAQPRO-158 AC-9).
- CLAUDE.md "Public surface" section still references the polling/scheduling shape consistent with this decision; no CLAUDE.md edit required for D-51 specifically.
- If push-based ingress is ever revisited, STAQPRO-108 is the re-opened tracker; it would also re-introduce the STAQPRO-115 watch-renewal requirement.
