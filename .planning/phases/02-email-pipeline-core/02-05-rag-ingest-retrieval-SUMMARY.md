---
phase: 02-email-pipeline-core
plan: 02-05
status: shipped via Linear (lean execution — no GSD plan-promotion). Substance complete; KB ingest live; counterparty-scoped retrieval live.
date: 2026-05-07
mode: retroactive
sources: Linear STAQPRO-188, 190, 191, 192, 198, 199, 200, 207, 208, 219, 220, 122, 148, 235
supersedes: 02-05-rag-ingest-retrieval-PLAN-v2-2026-04-27-STUB.md (stub authoritative until shipped via Linear)
---

# 02-05: RAG Ingest + Retrieval — SUMMARY (retroactive)

This SUMMARY is written after the fact. The v2 STUB was never promoted to a
full GSD PLAN; substance shipped through Linear tickets between 2026-05-01
and 2026-05-07 in the M3.5 RAG track. CLAUDE.md's `### RAG retrieval (M3.5
/ STAQPRO-191)` and `### RAG ingestion (M3.5 / STAQPRO-190)` sections are
the canonical live-shape reference; this SUMMARY closes the GSD audit
trail.

## What shipped

### STAQPRO-188 — Qdrant `email_messages` collection (768d / Cosine)
- Bootstrap profile: `docker compose --profile qdrant-bootstrap run mailbox-qdrant-bootstrap`
- Idempotent — re-runs on every appliance boot are safe
- Payload indexes: `message_id`, `thread_id`, `sender`, `direction`, `sent_at`, `classification_category`
- Files: `dashboard/scripts/qdrant-bootstrap.ts`, `dashboard/lib/rag/qdrant.ts`

### STAQPRO-190 — ingestion (inbound auto + outbound explicit + backfill)
- **Inbound (auto):** `/api/internal/inbox-messages` POST fires fire-and-forget `embedText() → upsertEmailPoint()` after `created=true` insert. Latency runs in parallel; n8n's response is not blocked.
- **Outbound (explicit):** `POST /api/internal/embed` (`dashboard/app/api/internal/embed/route.ts`). MailBOX-Send workflow calls this after `Mark Sent` via `http://mailbox-dashboard:3001/api/internal/embed`. Idempotent on `message_id` (deterministic point UUID via `pointIdFromMessageId` = sha256-derived).
- **Backfill (one-shot):** `npm run rag:backfill` / `dashboard/scripts/rag-backfill.ts` over `RAG_BACKFILL_LOOKBACK_DAYS` (default 90). Idempotent on point UUID. Gmail History-API backfill (pre-appliance history) intentionally deferred — local-row corpus is the v1 starting point.
- Failure semantics: every RAG path returns success-shaped responses on Ollama or Qdrant outage so the draft pipeline keeps running. RAG is augmentation, not gate.

### STAQPRO-191 — counterparty-scoped retrieval at draft-assembly time
- `POST /api/internal/draft-prompt` embeds the inbound message and queries Qdrant with a hard sender filter (`payload.sender == inbound.from_addr`). Top-k snippets land in `lib/drafting/prompt.ts` `rag_refs`.
- Tunables: `RAG_RETRIEVE_TOP_K` (default 3, sized for the 4096-token Qwen3 context per DR-18), `RAG_RETRIEVE_EXCERPT_CHARS` (default 600 ≈ 150 tokens per snippet).
- Privacy gate (cloud route): per project Constraint *"All email content stored only on local appliance"*, retrieval on the cloud route is opt-in via `RAG_CLOUD_ROUTE_ENABLED=1`. Default off → `{ refs: [], reason: 'cloud_gated' }` and drafting falls back to persona-stub.
- Failure modes (`retrieveForDraft` in `dashboard/lib/rag/retrieve.ts`): `cloud_gated`, `embed_unavailable`, `qdrant_unavailable`, `no_hits`, `disabled`. Reason persisted alongside refs.

### STAQPRO-192 — refs traceability (`drafts.rag_context_refs` + archival)
- Migration 013: `rag_retrieval_reason TEXT DEFAULT 'none'` on drafts.
- `drafts.rag_context_refs` (jsonb default `[]`) populated at draft-assembly. Truth at draft time.
- `sent_history.rag_context_refs` carried over by the migration 010 archival trigger (STAQPRO-189) at the moment status flips to `sent`. Truth at send time.
- Both are point-in-time snapshots; later edits or re-retrievals do NOT retroactively write back. Combined with `mailbox.state_transitions` (STAQPRO-185), this gives a full audit chain: retrieval refs → draft → final outcome (approved | edited | rejected | sent).

### STAQPRO-198 — `RAG_DISABLED` operator-only gate
- Eval harness can short-circuit retrieval to compare with/without RAG quality. Returns `{ refs: [], reason: 'disabled' }`. Operator-only; never set in production.
- Customer-#1 RAG eval baseline + paired-stats result captured in `docs/runbook/rag-eval.v0.1.0.md` (commit `27db66d`).

### STAQPRO-199 / 200 — nomic embed input bounds
- 199: truncate input + `num_ctx=8192` on nomic embed call (avoid silent embedding-quality cliffs on long inputs).
- 200: drop in-code `EMBED_MAX_CHARS` default 6000 → 4500 (matches the n8n side; prevents the embedding from drifting per-environment).

### STAQPRO-207 — phase-2 eval re-run + Phase-D hypotheses
- Re-ran the RAG eval after STAQPRO-191/192 with the new retrieval shape.
- Documented Phase-D hypotheses for the next eval iteration in `docs/runbook/rag-eval.v0.2.0.md`.

### STAQPRO-208 — Gmail Get scope tightened
- Gmail Get filter: `unread + newer_than:2d` to prevent burst-overflow message loss after a long ingest pause. Touches the upstream side of the RAG corpus growth path.

### STAQPRO-219 — drop inbound's own point UUID from retrieval
- Symptom: a freshly-embedded inbound was retrieving itself as its own top match (cosine ≈ 1.0), starving the top-k of actually-similar prior-thread context.
- Fix: filter `point_id != pointIdFromMessageId(inbound.message_id)` at retrieval time. Inbound is still embedded (so the next reply benefits), just excluded from its own retrieval.

### STAQPRO-220 — LLM-judge eval mode (Haiku 4.5 + gpt-oss:120b)
- Replaces the manual rubric scoring with an automated LLM-judge pass. Both Haiku 4.5 and gpt-oss judges are wired; comparison captured in `docs/runbook/rag-eval.v0.3.0.md`.

### STAQPRO-122 / 148 — KB document ingest pipeline (RAG-04)
- The PDF/DOCX/CSV upload path (the original RAG-04 requirement; v1 stub described `dashboard/backend/src/routes/kb.ts`).
- Live shape: `dashboard/lib/rag/kb-{chunker,ingest,parsers,qdrant,reconciler}.ts` + `scrub.ts` (PII / signature scrub on extracted text).
- Migration 014: `kb_documents` + `kb_refs` tables in the `mailbox` schema.
- UI: `dashboard/app/settings/kb/page.tsx` + AppNav entry + compose volume mount.
- Dockerfile: pre-creates `/var/lib/mailbox/kb` with `nextjs:nodejs` ownership.
- Linus pre-flight commit `16656d9`: `kb_reason='none'` on early-exits, 600-char `kbBlock` cap.
- Eval harness mock extended with `kb_refs` / `kb_reason` for type contract (commits `48d8cf5`, `14446ef`).

### STAQPRO-235 — post-onboarding KB nudge UI
- `/settings/kb` post-onboarding nudge prompts the operator to upload knowledge base documents after the first successful send. Closes the loop on KB adoption.

## Files of record

### Library
- `dashboard/lib/rag/qdrant.ts` — Qdrant client, `pointIdFromMessageId`, `upsertEmailPoint`
- `dashboard/lib/rag/embed.ts` — nomic-embed-text v1.5 wrapper with truncate + num_ctx
- `dashboard/lib/rag/retrieve.ts` — `retrieveForDraft` with sender filter, self-exclusion, cloud-gate, failure-mode reasons
- `dashboard/lib/rag/excerpt.ts` — snippet trimming to `RAG_RETRIEVE_EXCERPT_CHARS`
- `dashboard/lib/rag/scrub.ts` — PII / signature scrub for KB ingest
- `dashboard/lib/rag/eval-baseline.ts` — eval harness (used by `dashboard/scripts/rag-eval.ts`)
- `dashboard/lib/rag/kb-chunker.ts` — paragraph chunking for KB documents
- `dashboard/lib/rag/kb-ingest.ts` — orchestrates parse → chunk → embed → upsert for KB uploads
- `dashboard/lib/rag/kb-parsers.ts` — PDF/DOCX/CSV → text
- `dashboard/lib/rag/kb-qdrant.ts` — KB-specific Qdrant collection / payload indexes
- `dashboard/lib/rag/kb-reconciler.ts` — drift reconciler between `kb_documents` table and Qdrant points

### API routes
- `dashboard/app/api/internal/draft-prompt/route.ts` — POST, retrieves + assembles
- `dashboard/app/api/internal/embed/route.ts` — POST, outbound explicit ingest
- `dashboard/app/api/internal/inbox-messages/route.ts` — POST, inbound auto-ingest hook
- `dashboard/app/api/kb/route.ts` (and sub-routes for upload/list/delete)

### Scripts
- `dashboard/scripts/qdrant-bootstrap.ts`
- `dashboard/scripts/rag-backfill.ts`
- `dashboard/scripts/kb-smoke.ts`
- `dashboard/scripts/rag-eval.ts`

### Migrations
- `dashboard/migrations/013-add-rag-retrieval-reason-v1-2026-05-02.sql`
- `dashboard/migrations/014-create-kb-documents-and-refs-v1-2026-05-02.sql`

### Docs / runbooks
- `docs/runbook/rag-eval.v0.1.0.md` — paired-stats baseline (STAQPRO-198)
- `docs/runbook/rag-eval.v0.2.0.md` — phase-2 re-run + Phase-D hypotheses (STAQPRO-207)
- `docs/runbook/rag-eval.v0.3.0.md` — LLM-judge mode (STAQPRO-220)

### UI
- `dashboard/app/settings/kb/page.tsx` (+ AppNav entry)

## Deviations from v2 STUB

- **Express → Next.js**: stub described `dashboard/backend/src/rag/{client,chunk,embed}.ts` and `dashboard/backend/src/routes/kb.ts`. Live shape is `dashboard/lib/rag/*.ts` + `dashboard/app/api/{internal,kb}/...` per the 2026-04-27 Next.js full-stack ADR.
- **Counterparty filter at retrieval**: stub did not specify the `payload.sender == inbound.from_addr` hard filter; this was added in STAQPRO-191 to keep retrieval scoped to the same conversational counterparty. Improves precision; trades off cross-thread recall (acceptable for the operator-email use case).
- **Cloud-route privacy gate**: stub treated retrieval as always-on. Live shape gates retrieval behind `RAG_CLOUD_ROUTE_ENABLED` on the cloud route per project Constraint. Default off.
- **Self-exclusion at retrieval (STAQPRO-219)**: not anticipated by the stub; emerged in eval.
- **KB schema (`kb_documents` / `kb_refs`)**: stub left this implicit. Migration 014 made it explicit.

## Deferred / not in scope

- **Gmail History-API backfill** (pre-appliance corpus): explicitly deferred. Local-row corpus is v1.
- **Cross-thread / global retrieval mode** for the cases where strict counterparty scoping starves recall: parked for an eval-driven decision in M4+.
- **Persona signature stripping inside retrieval excerpts** (avoid showing the operator their own sign-off): tracked but not done. Considered for STAQPRO-234 follow-up.

## Linear ticket trail

| Ticket | Scope | Status |
|--------|-------|--------|
| STAQPRO-122 | KB ingest pipeline (parent) | Done |
| STAQPRO-148 | KB UI + AppNav + Dockerfile + compose volume | Done |
| STAQPRO-188 | Qdrant `email_messages` collection bootstrap | Done |
| STAQPRO-190 | Inbound auto + outbound explicit + backfill ingest | Done |
| STAQPRO-191 | Counterparty-scoped retrieval at draft-assembly | Done |
| STAQPRO-192 | `rag_context_refs` traceability + archival snapshot | Done |
| STAQPRO-198 | `RAG_DISABLED` eval gate | Done |
| STAQPRO-199 | nomic embed truncate + num_ctx=8192 | Done |
| STAQPRO-200 | EMBED_MAX_CHARS 6000 → 4500 | Done |
| STAQPRO-207 | Phase-2 eval re-run + Phase-D hypotheses | Done |
| STAQPRO-208 | Gmail Get scope tightening (corpus side) | Done |
| STAQPRO-219 | Drop inbound's own point UUID from retrieval | Done |
| STAQPRO-220 | LLM-judge eval mode | Done |
| STAQPRO-235 | Post-onboarding KB nudge UI | Done |

## Requirements covered

RAG-01 (embed inbound), RAG-02 (embed outbound), RAG-03 (retrieve at draft time), RAG-04 (KB document upload — PDF/DOCX/CSV), RAG-05 (similarity threshold — implicit via top-k + sender filter; explicit threshold deferred for eval-driven tuning), RAG-06 (retrieval refs surfaced in draft).

## Next: 02-06 persona, 02-07 drafting, 02-08 onboarding

This SUMMARY closes the GSD audit trail for 02-05. RAG is consumed by 02-07
drafting (already shipped) and exposed to operators through the 02-08
onboarding wizard's KB step (in progress at M3 close).
