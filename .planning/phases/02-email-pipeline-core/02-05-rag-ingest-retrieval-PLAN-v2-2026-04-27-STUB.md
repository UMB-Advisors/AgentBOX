---
plan_number: 02-05
plan_version: v2-stub
plan_date: 2026-04-27
supersedes: 02-05-rag-ingest-retrieval-PLAN.md (v1, 2026-04-13)
status: STUB — defer full task breakdown until cross-plan decisions resolved
slug: rag-ingest-retrieval
wave: 3
depends_on: [02-02, 02-03]
autonomous: false
requirements: [RAG-01, RAG-02, RAG-03, RAG-04, RAG-05, RAG-06]
files_modified_estimate:
  - dashboard/lib/rag/client.ts
  - dashboard/lib/rag/chunk.ts
  - dashboard/lib/rag/embed.ts
  - dashboard/app/api/kb/documents/route.ts
  - dashboard/app/api/kb/documents/[id]/route.ts
  - dashboard/app/api/internal/rag-search/route.ts
  - n8n/workflows/06-rag-ingest-sent-history.json
  - n8n/workflows/07-rag-index-new-message.json
---

<rescope_note>
**THIS IS A STUB. DO NOT EXECUTE.**

Captures shape and surfaces decisions for plan 02-05. Full task
breakdown deferred until 02-03..08 stubs are complete.

See `02-CONTEXT-ADDENDUM-v2-2026-04-27.md` for D-25..D-N.
See `02-02-schema-foundation-PLAN-v2-2026-04-27.md` for active
schema/code patterns (raw `pg`, `dashboard/lib/` layout).
</rescope_note>

<changes_from_v1>

1. **File locations**: v1's `dashboard/backend/src/rag/*` becomes
   `dashboard/lib/rag/*` (Next.js convention). Express router
   `routes/kb.ts` splits into Next.js App Router files at
   `dashboard/app/api/kb/documents/route.ts` (POST list, GET list)
   and `dashboard/app/api/kb/documents/[id]/route.ts` (DELETE).

2. **Qdrant client**: existing `@qdrant/js-client-rest` package is
   in Ubuntu's 02-01 dependencies but NOT in the Jetson's
   `dashboard/package.json`. 02-05-v2 adds it via `npm install`.

3. **Onboarding state writes**: v1's progress writes target
   `mailbox.onboarding.ingest_progress_total` /
   `ingest_progress_done`. These columns exist in 02-02-v2's
   onboarding migration. Workflow updates them via direct n8n
   Postgres node UPDATE (per D-26).

4. **Ingest trigger**: v1 says "invoked from the onboarding flow
   (Plan 02-08) with `{customer_key}` input." 02-08-v2 stub will
   define exactly how this is invoked (n8n REST API, internal
   webhook, or operator button). For now, 02-05 owns the workflow
   shape and the input contract; 02-08 owns the trigger.

5. **Existing data**: zero rows in `mailbox.sent_history` or any
   other table 02-05 reads from. RAG ingest starts from a clean
   Qdrant collection on first run. The 6 dogfood
   `inbox_messages` rows are preserved but not yet indexed; the
   `07-rag-index-new-message` workflow can backfill them
   incrementally.

</changes_from_v1>

<decisions_to_resolve>

**D-33 — Qdrant collection topology**

Single collection (`mailbox_rag`) for everything, or separate
collections per source (sent / inbound / documents) or per category?

Single collection with payload filtering is simpler — one schema,
one upsert path, filters at query time via Qdrant's payload-filter
support. Qdrant payload indexes on `source` keep filter latency low.

Per-source collections would let you tune chunk overlap or
embedding params per source type, but you can't (you're stuck with
nomic-embed-text v1.5 across the board).

**Decision:** Single collection `mailbox_rag` with payload-indexed
fields `source`, `source_id`, `category` (denormalized from the
inbound classification when source is `inbound_email`). Multi-tenant
later (`customer_key` payload field) but Phase 2 single-tenant.

Rejected: per-source collections (over-engineering for one tenant);
per-customer collections (premature multi-tenancy).

**D-34 — Chunking strategy per source**

v1 specifies per-email chunking for sent history (whole email = 1
chunk) and per-paragraph chunking for uploaded documents.

For sent emails this is reasonable — most CPG operator email is
short (a few hundred words). Edge case: a 5000-word legal brief in
sent history would exceed nomic-embed-text v1.5's 2K-token context
window and silently get truncated.

**Decision:** Soft cap of 1500 tokens per chunk (well under the 2K
ceiling). Sent emails under 1500 tokens = 1 chunk. Sent emails over
1500 tokens get paragraph-split. Documents are always paragraph-
split. Use the same `chunk()` function for both, parameterized by
source type. Document metadata (page number for PDFs, row number for
CSVs) stored in payload `meta.location`.

Rejected: per-email-always (truncates long emails); per-paragraph-
always (loses cross-paragraph context for short emails).

**D-35 — Document upload format support**

v1 lists PDF, DOCX, CSV. PDF parsing on ARM64 is finicky —
`pdf-parse` and similar libraries pull binary deps that don't always
build cleanly on Jetson. CSV is trivial. DOCX needs `mammoth`.

**Decision (Phase 2):** Support DOCX and CSV in 02-05. Defer PDF to
a follow-up (Phase 2.5 or Phase 3). Operator workflow during
white-glove onboarding: ask for product catalog as DOCX or CSV; if
they only have PDF, convert it (manually or via separate tool)
before upload. Document this in the onboarding handhold script.

Rejected: blocking Phase 2 on PDF support (binary-deps risk on
ARM64); accepting all formats and silently degrading on PDF parse
failures.

**D-36 — Embedding endpoint location**

Two paths to call nomic-embed-text:
- (a) n8n HTTP Request node calls `http://ollama:11434/api/embeddings`
  directly. Workflow loops over chunks, embeds, upserts to Qdrant.
- (b) Next.js helper at `dashboard/lib/rag/embed.ts` exposed via
  `POST /dashboard/api/internal/rag-embed` that accepts a list of
  texts, returns vectors. n8n calls this single endpoint instead.

For ingestion, (a) is simpler — n8n already orchestrates the loop.
For drafting (02-07) the same embedding call happens for the inbound
email, where (b) is more natural (drafting context-builder is in
TypeScript already).

**Decision:** Implement both — `dashboard/lib/rag/embed.ts` is the
canonical embedding function (used by 02-05 document upload and by
02-07 drafting context). The n8n ingest workflow calls Ollama
directly via HTTP node (path (a)) for sent-history bulk ingestion
because routing through Next.js for thousands of chunks adds
unnecessary network hops. One canonical *implementation*, two
invocation paths chosen by latency/throughput needs.

Rejected: route everything through Next.js (slow for bulk ingest);
duplicate embedding logic in n8n + TypeScript (drift risk).

**D-37 — Top-K retrieval API contract for drafting (02-07)**

02-07's drafting context builder needs to fetch top-K relevant chunks.
The contract:
- input: query text (the inbound email body), category (for filtering),
  optional `k` (default 3 per v1)
- output: `[{ text, score, source, source_id, meta }]` array

**Decision:** Expose as `POST /dashboard/api/internal/rag-search` with
the input/output above. Threshold 0.72 (RAG-05) applied server-side
before returning. This is the only API surface 02-07 needs from RAG;
all other RAG operations stay internal (lib functions called from
workflow JSON or Next.js routes).

Rejected: have 02-07 import `lib/rag/client.ts` directly — works but
couples Phase 2 plans tighter than necessary; the API boundary is
testable in isolation.

</decisions_to_resolve>

<dependencies_on_other_stubs>

- **02-03 (IMAP ingestion)**: 02-05's `07-rag-index-new-message`
  workflow listens for new `inbox_messages` rows (via Postgres trigger
  or polled INSERT). Contract: workflow runs every N seconds (or on
  Postgres LISTEN/NOTIFY — D-38 below in future stubs), reads new
  rows since last indexed timestamp, chunks + embeds + upserts. 02-03
  needs no changes; 02-05 reads from `inbox_messages` independently.

- **02-06 (persona)**: persona extraction reads sent-history corpus
  AFTER 02-05 has ingested it. Persona runs on the
  `mailbox.inbox_messages` table (sent-folder rows), not Qdrant —
  Qdrant is just for retrieval. So 02-06 doesn't depend on 02-05
  vector data, but DOES depend on 02-05's sent-history INSERT path
  populating `inbox_messages` from the IMAP Sent folder.

  **Sub-decision:** Are sent-history rows stored in
  `mailbox.inbox_messages` or in a separate table? v1 implies
  `inbox_messages` carries inbound-only. Surface in 02-06 stub.

- **02-07 (draft generation)**: calls `POST /dashboard/api/internal/
  rag-search` (per D-37) to get top-K refs. Persists `rag_context_refs`
  JSONB to `mailbox.drafts` row.

- **02-08 (onboarding wizard)**: triggers `06-rag-ingest-sent-history`
  workflow. Updates `mailbox.onboarding.ingest_progress_*` based on
  the workflow's writes. 02-08 also handles document upload from the
  wizard — calls `POST /dashboard/api/kb/documents` (defined here).

</dependencies_on_other_stubs>

<tasks_outline>

Sketch only; not executable.

1. Add `@qdrant/js-client-rest` and `mammoth` (for DOCX) to
   `dashboard/package.json` deps; bump dependency lock
2. Create `dashboard/lib/rag/client.ts` — Qdrant client wrapper,
   `ensureCollection()`, `upsert()`, `search()`, `deleteBySourceId()`
3. Create `dashboard/lib/rag/chunk.ts` — chunking with the 1500-token
   soft cap (D-34), parameterized by source type
4. Create `dashboard/lib/rag/embed.ts` — nomic-embed-text invocation
   helper (D-36)
5. Create `dashboard/app/api/kb/documents/route.ts` — POST for upload
   (DOCX, CSV per D-35), GET for list
6. Create `dashboard/app/api/kb/documents/[id]/route.ts` — DELETE
7. Create `dashboard/app/api/internal/rag-search/route.ts` — top-K
   retrieval API for 02-07 (D-37)
8. Create `n8n/workflows/06-rag-ingest-sent-history.json`:
   IMAP fetch from `Sent Mail` folder → loop → chunk → embed (HTTP
   to Ollama per D-36) → upsert to Qdrant → INSERT to inbox_messages
   with `source='sent'` (or however we resolve the sent-vs-inbound
   storage question)
9. Create `n8n/workflows/07-rag-index-new-message.json`:
   periodic poll of inbox_messages WHERE indexed_at IS NULL → chunk
   → embed → upsert (incremental indexing per RAG-03)
10. Smoke test: upload a sample DOCX, verify chunks land in Qdrant
    with correct payload; trigger sent-history ingest with a real
    Gmail Sent folder, verify progress writes to onboarding row

</tasks_outline>

<deferred_items>

- PDF support (per D-35) — Phase 2.5 or Phase 3
- Per-customer Qdrant collections (per D-33) — multi-tenant Phase 3+
- Postgres LISTEN/NOTIFY for incremental indexing — Phase 2 uses
  polling per RAG-03; optimize later if poll latency hurts
- Embedding model upgrade to nomic-embed-text-v2-moe — explicitly
  rejected in CLAUDE.md (memory budget)
- Hybrid search (vector + keyword) — Phase 3 if pure vector retrieval
  proves insufficient for accuracy

</deferred_items>
