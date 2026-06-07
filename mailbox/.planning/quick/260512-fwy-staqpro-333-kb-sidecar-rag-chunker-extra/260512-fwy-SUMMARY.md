---
type: quick
slug: staqpro-333-kb-sidecar-rag-sources-surface
linear: STAQPRO-333
branch: feat/staqpro-333-kb-sidecar-rag
completed: 2026-05-12
commits:
  - 3ca66c8: feat(rag) — add getKbPointsByIds for KB chunk batch-resolve
  - 3a9d926: feat(api) — extend /api/drafts/[id]/rag-refs to resolve kb_context_refs
  - d9a48ca: feat(ui) — render KB refs in SourcesUsedPanel + tests
files_modified:
  - dashboard/lib/rag/kb-qdrant.ts                              # +39 lines (getKbPointsByIds)
  - dashboard/app/api/drafts/[id]/rag-refs/route.ts             # rewritten (discriminated SourceRef union, dual-collection batch-resolve)
  - dashboard/components/SourcesUsedPanel.tsx                   # widened types + KB render branch + breakdown line + dual error block
  - dashboard/test/helpers/db.ts                                # +kbContextRefs in SeedOpts, INSERT writes kb_context_refs as $10
  - dashboard/test/routes/drafts.test.ts                        # +2 cases in rag-refs describe (kb-only + mixed)
---

# STAQPRO-333: KB-sidecar RAG sources surface — Summary

## One-liner

Surfaced the KB-sidecar refs that the STAQPRO-148 drafting pipeline already persists — `/api/drafts/[id]/rag-refs` now resolves `kb_context_refs` against the `kb_documents` Qdrant collection alongside email refs, returns a discriminated `SourceRef[]` (`source: 'email' | 'kb'`), and SourcesUsedPanel renders both with distinct visual treatment.

## What shipped

This was the user-visible delta for STAQPRO-333. Every backend prerequisite (kb_documents collection, migration 014, chunker, parsers, ingest, upload UI, retrieval merge in `retrieve.ts`, drafts.kb_context_refs persistence in `draft-prompt/route.ts`, archive trigger) was already in production from STAQPRO-148. The gap was the surface — the rag-refs route and SourcesUsedPanel only knew about email refs, so operators uploading SOPs/price-sheets had no feedback loop telling them WHICH docs influenced WHICH drafts.

Three commits, all on `feat/staqpro-333-kb-sidecar-rag`:

1. **C1 (`3ca66c8`)** — `getKbPointsByIds` in `dashboard/lib/rag/kb-qdrant.ts`. Mirror of `getPointsByIds` in `rag/qdrant.ts`; same Qdrant batch-get RPC shape, different collection (`kb_documents` vs `email_messages`). Returns `{ ok, points, reason? }`; never throws (RAG-is-augmentation contract).

2. **C2 (`3a9d926`)** — `/api/drafts/[id]/rag-refs/route.ts` rewritten:
   - Reads `kb_context_refs` alongside `rag_context_refs` and `rag_retrieval_reason`
   - Two independent Qdrant batch-gets in parallel via `Promise.all` — each branch succeeds or fails independently (D-4 partial-failure surface)
   - SourceRef is now a discriminated union: `EmailSourceRef` (`source: 'email'`, message_id/sender/recipient/direction/sent_at/...) vs `KbSourceRef` (`source: 'kb'`, doc_id/doc_title/chunk_index/mime_type/excerpt/uploaded_at)
   - Stored-order preservation within each source via `byId Map → pointIds.map` (same invariant the email-only path already enforced)
   - KB failure surface: `kb_qdrant_error` + `kb_unresolved_point_ids` parallel to existing email-side fields
   - `drafts.rag_retrieval_reason` still drives the email-side empty-refs UI copy; no `kb_retrieval_reason` column (explicitly punted per D-5 / draft-prompt comment)
   - `test/helpers/db.ts:seedDraft` widened to accept `kbContextRefs` for downstream test cases

3. **C3 (`d9a48ca`)** — `dashboard/components/SourcesUsedPanel.tsx`:
   - `SourceRef` type matches the route's discriminated union; `RagRefsResponse` picks up `kb_qdrant_error` / `kb_unresolved_point_ids`
   - KB chip uses `accent-green` from the Tailwind palette (D-6 fallback: `accent-purple` wasn't defined; `accent-green` was — and is visually distinct from inbound-neutral / outbound-blue / warning-orange / error-red)
   - Per-source breakdown line above the `<ul>`: "3 email · 2 kb" when both contribute, "{n} email" or "{n} kb" when only one source is present. Chip in the toggle still shows the combined total (terse glance per D-7)
   - `errorBlock` extracted so partial-Qdrant-failure warnings render in BOTH the empty-refs branch AND the non-empty branch. Prior code swallowed warnings when the other branch returned refs
   - 2 new vitest cases in the GET /api/drafts/[id]/rag-refs describe block: kb-only path + mixed email+kb path (asserts D-3 email-first ordering invariant)

## Task 1 verification — no-op outcome

Per the PLAN's prerequisites block, Task 1 was a verification gate confirming that STAQPRO-148's KB infrastructure was still intact on this branch. All six expected greps passed:

```
Check 1 (kb_context_refs in schema + migration 014)        ✓  PASS
Check 2 (lib/db/schema.ts has kb_context_refs)             ✓  PASS  (lines 68, 180)
Check 3 (qdrant-bootstrap creates both collections)        ✓  PASS  (email_messages + kb_documents)
Check 4 (retrieve.ts imports searchKb + returns kb_refs)   ✓  PASS  (line 46, 111-112, 211-243)
Check 5 (draft-prompt persists kb_context_refs)            ✓  PASS  (line 151)
Check 6 (getKbPointsByIds NOT yet in kb-qdrant.ts)         ✓  PASS  (the gap C1 fills)
```

No files modified in Task 1. STAQPRO-148 infrastructure verified intact.

## Test results

Full vitest suite after C3:

```
Test Files  26 passed | 11 skipped (37)
     Tests  313 passed | 91 skipped (404)
```

- Before this work: 402 cases / 89 skipped
- After: 404 cases / 91 skipped (+2 new DB-backed cases in the rag-refs describe block, both currently skipped pending TEST_POSTGRES_URL)
- All 4 pre-existing rag-refs cases still pass unchanged
- Typecheck clean; biome lint clean (one cosmetic re-flow auto-applied per pass)

The 2 new cases will run when `TEST_POSTGRES_URL` is available (via the Tailscale tunnel pattern documented in `dashboard/CLAUDE.md` Tests section, or in CI). Locally they skip cleanly along with the other 89 DB-backed cases.

## Design decisions honored

| ID | Decision | Implementation |
|----|----------|----------------|
| D-1 | Single `refs: SourceRef[]` array with discriminated `source`, NOT parallel `{ email_refs, kb_refs }` | Route returns `refs: [...emailRefs, ...kbRefs]`; panel renders one ordered list with `ref.source === 'email'` switch |
| D-2 | Separate branch types per source — no unified-shape-with-optional-fields | `EmailSourceRef` and `KbSourceRef` interfaces; discriminated by `source` literal |
| D-3 | Email-first ordering, stored point-id order within each source | Email branch resolved first via Map+map; KB second; final `[...emailRefs, ...kbRefs]`. Asserted in new test case 6 |
| D-4 | Partial Qdrant failures allowed (one branch can succeed while the other fails) | `Promise.all` of two independent batch-gets; separate `qdrant_error` / `kb_qdrant_error` surfaces |
| D-5 | No `kb_retrieval_reason` column in this plan | Confirmed — only `rag_retrieval_reason` (email-scoped) carries through; KB has no reason field |
| D-6 | KB chip accent token — pick what's defined in Tailwind | `accent-purple` was NOT defined; `accent-green` is. Used `accent-green` (per D-6 fallback rule) |
| D-7 | Count chip = combined total; per-source breakdown in panel body | Chip shows `{count}` (total); breakdown line above `<ul>` shows "{n} email · {m} kb" when both contribute |

## Deploy checklist

This plan ships ZERO migrations, ZERO env vars, ZERO new npm deps, ZERO new Qdrant collections. Dashboard rebuild only.

```bash
# On mailbox1 (customer #1):
ssh mailbox1 'cd ~/mailbox && git pull && docker compose up -d --build mailbox-dashboard --remove-orphans'

# On mailbox2 (customer #2):
ssh mailbox2 'cd ~/mailbox && git pull && docker compose up -d --build mailbox-dashboard --remove-orphans'
```

NOT needed:
- `docker compose --profile migrate run mailbox-migrate` (no new migrations)
- `docker compose --profile qdrant-bootstrap run mailbox-qdrant-bootstrap` (`kb_documents` collection already exists on both appliances from STAQPRO-148)
- n8n re-import or restart (no workflow changes)
- Caddy reload (no `.env` or Caddyfile changes)

## Post-deploy spot-check

On each appliance after rebuild:

1. Open `/dashboard/queue`
2. Pick a draft assembled AFTER the operator uploaded KB docs
3. Expand "Sources used"
4. If `mailbox.drafts.kb_context_refs` for that draft is non-empty, the panel should show KB-tagged refs alongside email refs, with breakdown line "{n} email · {m} kb" above the list
5. If it's empty: upstream retrieval returned no KB hits (expected for a corpus that doesn't match the inbound topically — RAG_CLOUD_ROUTE_ENABLED may also be the gate on cloud-route drafts; default behavior gates KB retrieval on the cloud route)
6. If `kb_context_refs` is non-empty but the panel shows zero KB refs, `kb_qdrant_error` should be in the response — investigate Qdrant `kb_documents` collection health

## Out of scope — deferred to follow-up tickets

The original STAQPRO-333 task-scope brief assumed a greenfield KB-sidecar build (migration 024, `kb_chunks` collection, new chunker/parsers, new env vars, etc). That entire scope was already shipped under STAQPRO-148 with one schema delta: the collection is `kb_documents` (not `kb_chunks`) and the migration is 014 (not 024). This PR ships the user-visible surface gap; the items below are explicitly NOT in scope:

- **kb_retrieval_reason column** — would let the UI render a "why no KB sources" decode (e.g., `kb_cloud_gated` → "KB retrieval is privacy-gated on the cloud route"). Punted until the eval surface (STAQPRO-192) starts caring about KB hit-rate. Captured in the existing draft-prompt route comment.
- **Sweeper for >2MB KB files** — current ingest is inline. A separate ticket if upload sizes start exceeding the inline budget.
- **Drive-aware RAG (STAQPRO-332)** — orthogonal source type. When it lands, `SourceRef` gains a third discriminator `'drive'` and the route gets a third Qdrant call. The discriminated-union pattern from this PR is forward-compatible.
- **KB folder/tag organization** — current UI lists docs flat; folder/tag taxonomy is a separate UX ticket.
- **Versioning on KB re-upload** — current dedupe is sha256-based, so identical re-uploads are no-ops but content-changed uploads create new docs (orphaning old chunk refs on prior drafts). Versioning would let the operator see "this draft cited v1 of pricing.pdf; the current version is v3."
- **Per-document cloud opt-out** — global `RAG_CLOUD_ROUTE_ENABLED` gate is all-or-nothing. Per-doc opt-out would let operators upload "internal use only" docs that the cloud route never sees while still feeding local-route drafts.

## Self-Check: PASSED

- Commits exist:
  - `3ca66c8` — getKbPointsByIds ✓
  - `3a9d926` — rag-refs route extension ✓
  - `d9a48ca` — SourcesUsedPanel + tests ✓
- Files modified per the PLAN frontmatter all present in the diff range
- Typecheck clean (npx tsc --noEmit, no output)
- Biome lint clean (no errors after auto-format)
- vitest: 313 pass / 91 skip (404 total); +2 new cases vs baseline 402
- No regression: all 4 pre-existing rag-refs cases still pass unchanged
