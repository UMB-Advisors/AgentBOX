---
type: quick
slug: staqpro-333-kb-sidecar-rag-sources-surface
linear: STAQPRO-333 (KB-sidecar RAG — operator-uploaded docs feed draft-time retrieval alongside email history)
branch: feat/staqpro-333-kb-sidecar-rag  # already checked out; do NOT create a new branch
files_modified:
  - dashboard/lib/rag/kb-qdrant.ts                                           # add getKbPointsByIds (sibling of email getPointsByIds)
  - dashboard/app/api/drafts/[id]/rag-refs/route.ts                          # also resolve kb_context_refs; tag refs with source: 'email' | 'kb'
  - dashboard/components/SourcesUsedPanel.tsx                                # widen SourceRef discriminated union; render kb chip + filename + uploaded-ago
  - dashboard/test/helpers/db.ts                                             # extend SeedOpts + seedDraft to accept kbContextRefs (mirror ragContextRefs pattern)
  - dashboard/test/routes/drafts.test.ts                                     # +2 cases in the rag-refs describe: kb-only + mixed email+kb

prerequisites:
  - The actual KB pipeline (collection + upload + ingest + retrieval merge + cloud gating + delete cascade + drafts.kb_context_refs persistence + sent_history.kb_context_refs archival trigger) IS ALREADY SHIPPED under STAQPRO-148. This plan ships the user-visible surface gap — the rag-refs route + SourcesUsedPanel both only know about email refs today. They need to also resolve and render the KB refs the drafter already persists.
  - Verified pre-existing infra (do NOT recreate or duplicate):
    - migration 014-create-kb-documents-and-refs-v1-2026-05-02.sql — adds mailbox.drafts.kb_context_refs + mailbox.sent_history.kb_context_refs + archive trigger update + kb_documents table
    - migration 020-drafts-exemplar-refs — extends archive trigger again to carry exemplar_refs (no kb impact, just noting the trigger is on its third revision)
    - dashboard/test/fixtures/schema.sql — already mirrors drafts.kb_context_refs + sent_history.kb_context_refs (lines 851 + 854)
    - dashboard/lib/db/schema.ts — already has Drafts.kb_context_refs + SentHistory.kb_context_refs (lines 68 + 180 in the generated file)
    - dashboard/lib/types.ts — already has SentHistory.kb_context_refs (line 216) + KbDocument view + KB_DOC_STATUSES const tuple + KbDocumentRow re-export
    - dashboard/lib/rag/kb-qdrant.ts — already has upsertKbPoint, pointIdFromChunk, searchKb, deleteKbPointsByDocId — only missing batch-get-by-ids
    - dashboard/lib/rag/kb-chunker.ts + kb-parsers.ts + kb-ingest.ts + kb-reconciler.ts — chunker, extractors, fire-and-forget ingest pipeline all live
    - dashboard/scripts/qdrant-bootstrap.ts — already creates BOTH collections (email_messages + kb_documents) idempotently; collection name is `kb_documents` (NOT `kb_chunks` as the task-scope brief said)
    - dashboard/app/api/kb-documents/route.ts + [id]/route.ts — POST upload (multipart + sha256 dedupe + fire-and-forget embed), GET list (with lazy reconciler boot hook), GET single, DELETE cascade (Qdrant first → DB → FS) — all shipped
    - dashboard/app/knowledge-base/page.tsx — operator-facing upload UI exists
    - dashboard/lib/rag/retrieve.ts — already does parallel email + KB search, returns { refs, reason, kb_refs, kb_reason }; cloud privacy gate via RAG_CLOUD_ROUTE_ENABLED applies to both arms with distinct reason values; RAG_DISABLED also gates both
    - dashboard/app/api/internal/draft-prompt/route.ts — already persists BOTH rag_context_refs (email UUIDs) AND kb_context_refs (KB UUIDs) unconditionally; already returns rag {refs_count, reason} + kb {refs_count, reason} envelopes
  - Pre-existing schema asymmetry that this plan honors: drafts has rag_retrieval_reason (TEXT, scoped to EMAIL retrieval per migration 013 + the draft-prompt route comment "rag_retrieval_reason carries the EMAIL retrieval reason for backward-compat with STAQPRO-192's existing eval surface. The KB reason currently lives only in the response body — if the eval surface starts caring about KB hit-rate, add a kb_retrieval_reason column then"). DO NOT add a kb_retrieval_reason column in this plan — it's out of scope and is explicitly punted in the draft-prompt route comment. The KB section of the rag-refs response will return refs only (no reason); if zero, the UI renders "no KB sources retrieved" with no reason-decode (the email reason value still drives the email branch's "why no sources" copy).
  - Docker must be running on the planner/executor host for `npm test` to bootstrap the temp postgres if running DB-backed cases locally; the cases skip cleanly without TEST_POSTGRES_URL.

must_haves:
  truths:
    - "GET /api/drafts/[id]/rag-refs returns BOTH email refs (resolved against email_messages collection) AND kb refs (resolved against kb_documents collection) — each tagged with source: 'email' | 'kb'."
    - "When a draft has zero email refs but non-zero kb refs (or vice versa), the route still returns 200 with the populated branch resolved and the empty branch reported as [] — no all-or-nothing behavior."
    - "Stored point-id order is preserved within each source (email refs keep their stored order, kb refs keep their stored order) — same invariant the existing email-only path already enforces."
    - "When Qdrant is unreachable for KB while email succeeds (or vice versa), the response surfaces unresolved point IDs only for the failing branch — partial success is the norm, not an error."
    - "SourcesUsedPanel renders KB refs with a distinguishable visual treatment from email refs (a 'KB' chip with a different accent token from the existing inbound/outbound chips) — operator can tell at-a-glance whether a draft cited their uploaded docs, their counterparty history, or both."
    - "SourcesUsedPanel toggle count shows the combined total when both sources are present; the per-source breakdown is visible in the count chip label (e.g., '3' overall, or a breakdown like '2 email · 1 kb' — UI executor picks the cleaner format consistent with existing chip styles)."
    - "The kb-context-refs payload-resolve never throws: if kb_documents Qdrant collection is unavailable (404 / 5xx / timeout), refs are returned empty and a kb_qdrant_error string surfaces in the response so the UI can render a degraded-state hint."
    - "No regression on the existing email-only rag-refs path: all 4 existing test cases in the GET /api/drafts/[id]/rag-refs describe block continue to pass unchanged."
  artifacts:
    - path: dashboard/lib/rag/kb-qdrant.ts
      provides: "getKbPointsByIds(ids) — batch-get against the kb_documents collection, returns { ok, points: [{id, payload: KbPointPayload}], reason? } shape mirroring the email getPointsByIds in lib/rag/qdrant.ts"
    - path: dashboard/app/api/drafts/[id]/rag-refs/route.ts
      provides: "Extended GET handler that reads BOTH drafts.rag_context_refs and drafts.kb_context_refs, batch-resolves each against its own collection, returns { reason, refs: SourceRef[] } where each SourceRef has a source: 'email' | 'kb' discriminator and a shape that matches the source type (email refs carry sender/recipient/direction; kb refs carry doc_id/doc_title/chunk_index/uploaded_at/mime_type)"
    - path: dashboard/components/SourcesUsedPanel.tsx
      provides: "Widened SourceRef discriminated union, kb branch render (KB chip + filename + uploaded-ago + excerpt), combined-count chip behavior"
  key_links:
    - from: dashboard/app/api/drafts/[id]/rag-refs/route.ts
      to: dashboard/lib/rag/kb-qdrant.ts
      via: "getKbPointsByIds([...kb_context_refs UUIDs]) call"
      pattern: "getKbPointsByIds\\("
    - from: dashboard/app/api/drafts/[id]/rag-refs/route.ts
      to: dashboard/lib/rag/qdrant.ts
      via: "existing getPointsByIds call (unchanged)"
      pattern: "getPointsByIds\\("
    - from: dashboard/components/SourcesUsedPanel.tsx
      to: dashboard/app/api/drafts/[id]/rag-refs/route.ts
      via: "fetch /api/drafts/{id}/rag-refs; SourceRef.source = 'email' | 'kb' drives the render branch"
      pattern: "source: 'email' \\| 'kb'"
    - from: dashboard/test/routes/drafts.test.ts
      to: dashboard/test/helpers/db.ts
      via: "seedDraft({ ragContextRefs, kbContextRefs, ragRetrievalReason })"
      pattern: "kbContextRefs"
---

<objective>
Surface the KB-sidecar refs that the drafting pipeline already persists. Drafts already record `kb_context_refs` (Qdrant point UUIDs in the `kb_documents` collection) at draft-assembly time per STAQPRO-148. The pipeline already retrieves KB hits, gates them through the same `RAG_CLOUD_ROUTE_ENABLED` privacy gate as email, and stores them in `mailbox.drafts.kb_context_refs` (jsonb). What's missing is the user-visible surface — today the rag-refs route and the SourcesUsedPanel only know about email refs, so an operator inspecting a draft has no way to tell whether their uploaded SOPs / price sheets / policy docs were cited. This plan closes that surface gap end-to-end.

Purpose: This is the final user-visible piece of the KB-sidecar RAG story for STAQPRO-333. Without it, operators upload docs (STAQPRO-148 already shipped that UI) and see them appear in the knowledge-base page, but have no feedback loop telling them WHICH docs are influencing WHICH drafts. The "Sources used" panel is where that feedback lives — extending it to discriminate email-history refs vs KB refs gives operators the diagnostic they need to (a) confirm uploads are working, (b) decide which docs to upload next based on which drafts cite them, and (c) catch retrieval failures (KB doc uploaded but never cited for a draft that should have used it).

Output:
- `getKbPointsByIds` helper added to `dashboard/lib/rag/kb-qdrant.ts` (mirror of the existing email `getPointsByIds` in `dashboard/lib/rag/qdrant.ts`, but against the `kb_documents` collection)
- `dashboard/app/api/drafts/[id]/rag-refs/route.ts` extended to also read `drafts.kb_context_refs` and batch-resolve against `kb_documents`; response shape widened to a discriminated `SourceRef` union with `source: 'email' | 'kb'`
- `dashboard/components/SourcesUsedPanel.tsx` extended to render the KB branch with a distinct visual treatment + combined-count chip
- Test scaffolding (`test/helpers/db.ts:seedDraft` accepts `kbContextRefs`) + 2 new test cases in `test/routes/drafts.test.ts` (kb-only path + mixed email+kb path)
- No new migrations, no new env vars, no new npm deps, no new Qdrant collections, no new Linear ticket sub-issues — every backend piece this plan needs already exists per STAQPRO-148
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@dashboard/CLAUDE.md

# Live code the executor MUST mirror — patterns are already established, do not invent
@dashboard/lib/rag/qdrant.ts                                  # getPointsByIds is the EXACT pattern to mirror for getKbPointsByIds
@dashboard/lib/rag/kb-qdrant.ts                               # existing KB client; the new helper lives here
@dashboard/app/api/drafts/[id]/rag-refs/route.ts              # existing route to extend, NOT replace
@dashboard/components/SourcesUsedPanel.tsx                    # existing panel to extend, NOT replace
@dashboard/lib/types.ts                                        # KbDocument view + KB_DOC_STATUSES already exported
@dashboard/test/helpers/db.ts                                  # seedDraft already accepts ragContextRefs/ragRetrievalReason — mirror that pattern
@dashboard/test/routes/drafts.test.ts                          # existing rag-refs describe block (lines 488-609) is the template

# Reference — pre-existing pipeline this plan piggy-backs on
@dashboard/lib/rag/retrieve.ts                                 # already returns kb_refs + kb_reason
@dashboard/app/api/internal/draft-prompt/route.ts              # already persists kb_context_refs
@dashboard/migrations/014-create-kb-documents-and-refs-v1-2026-05-02.sql

# Last quick task's plan shape — style reference only
@.planning/quick/260511-wsi-staqpro-331-1-structured-reject-feedback/260511-wsi-PLAN.md

<interfaces>
<!-- Key contracts the executor needs. These already exist in the codebase — extracted here so the executor does not need to re-explore. -->

From dashboard/lib/rag/qdrant.ts (the email-side pattern to mirror for kb-qdrant):
```typescript
export interface GetPointsResult {
  ok: boolean;
  points: Array<{ id: string; payload: EmailPointPayload }>;
  reason?: string;
}

export async function getPointsByIds(ids: readonly string[]): Promise<GetPointsResult> {
  if (ids.length === 0) return { ok: true, points: [] };
  try {
    const r = await qdrantRequest('POST', `/collections/${COLLECTION}/points`, {
      ids: [...ids],
      with_payload: true,
    });
    // ... (full handler — see existing file lines 228-254)
  }
}
```

From dashboard/lib/rag/kb-qdrant.ts (the KB payload shape to embed in the response):
```typescript
export interface KbPointPayload {
  doc_id: number;
  chunk_index: number;
  doc_title: string;
  doc_sha256: string;
  mime_type: string;
  excerpt: string;
  uploaded_at: string; // ISO 8601
}
```

From dashboard/app/api/drafts/[id]/rag-refs/route.ts (existing handler — extend, do not replace):
```typescript
interface SourceRef {
  point_id: string;
  message_id: string;
  sender: string;
  recipient: string;
  subject: string | null;
  body_excerpt: string;
  sent_at: string;
  direction: 'inbound' | 'outbound';
  classification_category: string | null;
}

// Reads drafts.rag_context_refs (UUIDs), calls getPointsByIds, returns
// { reason, refs: SourceRef[] } in stored point-id order.
```

From dashboard/components/SourcesUsedPanel.tsx (existing — same widening at the client):
```typescript
interface SourceRef { /* same shape as above */ }
interface RagRefsResponse {
  reason: string;
  refs: SourceRef[];
  qdrant_error?: string;
  unresolved_point_ids?: string[];
}
```

From dashboard/test/helpers/db.ts (existing seedDraft SeedOpts — extend, do not replace):
```typescript
interface SeedOpts {
  status?: DraftStatus;
  classification?: ClassificationCategory;
  draftBody?: string;
  draftSubject?: string;
  withClassification?: boolean;
  ragContextRefs?: readonly string[];
  ragRetrievalReason?: string;
}
// INSERT in seedDraft already writes rag_context_refs + rag_retrieval_reason columns.
// The plan extends to also accept kbContextRefs and write drafts.kb_context_refs.
```

From dashboard/lib/db/schema.ts (kysely-codegen output — already has the column):
```typescript
// In the Drafts interface (line ~68):
kb_context_refs: Generated<Json>;
// Plan uses this directly via kysely .select(['kb_context_refs', ...]).
```
</interfaces>

<design_decisions>
Locking the response-shape ambiguity in the task-scope brief BEFORE the executor starts:

D-1. Response shape: SINGLE `refs: SourceRef[]` array with a discriminated `source` field, NOT two parallel arrays (`{ email_refs, kb_refs }`). Rationale:
  - Mirrors how the drafter actually consumed them (one merged prompt block per retrieve.ts:assemblePrompt — both contribute to the same drafting context, the operator's mental model is "sources I cited," not "two separate lookups")
  - Simpler client iteration in SourcesUsedPanel — one `.map()` with a switch on `source`
  - Forward-compatible: when STAQPRO-332 adds Drive-aware RAG, source becomes 'email' | 'kb' | 'drive' with the same pattern
  - The drafting pipeline already returns kb in a separate envelope `{ kb: { refs_count, reason } }` from `/api/internal/draft-prompt` — that's the DRAFTING surface, distinct from this DEBUG/AUDIT surface

D-2. KB ref shape: a SEPARATE branch of the discriminated union, NOT a unified shape with optional fields. KB refs carry `doc_id` (NUMBER), `doc_title`, `chunk_index`, `mime_type`, `excerpt`, `uploaded_at` — fundamentally different from email's `message_id`/`sender`/`recipient`/`direction`/`sent_at`/`subject`/`classification_category`. Forcing them into one shape with everything optional produces a worse-typed client. Concrete TS:
```typescript
interface EmailSourceRef {
  source: 'email';
  point_id: string;
  message_id: string;
  sender: string;
  recipient: string;
  subject: string | null;
  body_excerpt: string;
  sent_at: string;
  direction: 'inbound' | 'outbound';
  classification_category: string | null;
}
interface KbSourceRef {
  source: 'kb';
  point_id: string;
  doc_id: number;
  doc_title: string;
  chunk_index: number;
  mime_type: string;
  excerpt: string;
  uploaded_at: string;
}
type SourceRef = EmailSourceRef | KbSourceRef;
```

D-3. Ordering: refs are ordered email-first (in stored email point-id order), then KB (in stored KB point-id order). NOT interleaved by score, NOT alphabetized — preserves the "what was in the prompt, in the order the model saw it" audit invariant. The drafting prompt assembler (`lib/drafting/prompt.ts`) injects rag_refs and kb_refs as two distinct blocks; this surface mirrors that block ordering.

D-4. Failure surface: PARTIAL Qdrant failures are allowed. If `getPointsByIds` (email) succeeds but `getKbPointsByIds` (KB) returns 503, the response is:
  ```
  { reason: 'ok', refs: [<email refs>], kb_qdrant_error: '503', kb_unresolved_point_ids: [...kb refs UUIDs] }
  ```
  Symmetric for the reverse case (`qdrant_error` / `unresolved_point_ids` for email — already implemented). NOT a top-level 502. The UI already handles `qdrant_error` for email; the KB branch gets parallel fields. Operators can always at least see the partially-resolved side.

D-5. KB reason: NOT surfaced in the response in this plan. As noted in prerequisites, the draft-prompt route comment explicitly punts kb_retrieval_reason as out-of-scope until eval surface needs it. The SourcesUsedPanel's "no KB sources retrieved" copy is unconditional (no reason-decode). If a future plan adds `drafts.kb_retrieval_reason` column, that ticket extends both the route response and the panel copy at that time.

D-6. KB chip accent token: planner verified candidate accents via `grep -rn 'accent-' dashboard/components/` patterns. The existing inbound/outbound chips use `accent-blue` (outbound) and a neutral border (inbound). The Reason warning uses `accent-orange`. Errors use `accent-red`. Free tokens for a KB chip: `accent-purple` or `accent-green`. The executor should verify which exists in the Tailwind config (`dashboard/tailwind.config.ts`) and pick one that's defined; if both are defined, prefer `accent-purple` (distinct from inbound/outbound's blue family AND from the orange/red warning family — clean separation). If neither exists, fall back to the existing inbound style with the text content "KB" providing the discrimination. The exact token is a 1-line edit; pick what compiles.

D-7. Count chip format: when both sources present, show the combined total in the chip (e.g., "5") and break down inline in the panel body header ("3 email · 2 kb"). Keep the chip terse — it's a glanceable affordance. When only one source is present, just show the count (no breakdown).
</design_decisions>
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Migration + qdrant-bootstrap extension — VERIFY NO-OP (skip if confirmed pre-existing)</name>
  <files>
    (verification only — no writes expected)
  </files>
  <action>
    Per the prerequisites block at the top of this PLAN, every backend piece the task-scope brief asked for is ALREADY shipped under STAQPRO-148. Before any code changes, the executor MUST verify this is still true on the current branch and decide whether this task collapses to a no-op or whether something has regressed since the prerequisites were authored.

    Run these checks. They are read-only:

    ```bash
    cd /home/bob/mailbox/dashboard

    # 1. Column exists on drafts + sent_history
    grep -n "kb_context_refs" test/fixtures/schema.sql migrations/014-*.sql

    # 2. Codegen output already exposes the column
    grep -n "kb_context_refs" lib/db/schema.ts

    # 3. Bootstrap script creates BOTH collections
    grep -n "kb_documents\|email_messages" scripts/qdrant-bootstrap.ts

    # 4. retrieve.ts already merges email + KB
    grep -n "searchKb\|kb_refs\|kb_reason" lib/rag/retrieve.ts

    # 5. draft-prompt route already persists kb_context_refs
    grep -n "kb_context_refs" app/api/internal/draft-prompt/route.ts

    # 6. KB client has upsert/search/delete but NOT yet a batch-get-by-ids
    grep -n "getKbPointsByIds\|getPointsByIds" lib/rag/kb-qdrant.ts lib/rag/qdrant.ts
    ```

    EXPECTED results (matches the prerequisites — no work needed in this task):
    - Check 1 returns hits in BOTH schema.sql AND migration 014 ✓
    - Check 2 returns `kb_context_refs: Generated<Json>;` in lib/db/schema.ts ✓
    - Check 3 returns both collection names ✓
    - Check 4 returns hits — retrieve.ts already imports searchKb and returns kb_refs/kb_reason ✓
    - Check 5 returns hits — draft-prompt already writes kb_context_refs unconditionally ✓
    - Check 6 returns getPointsByIds (in qdrant.ts) but NOT getKbPointsByIds — that's the gap Task 2 fills ✓

    If ALL six expectations hold → skip to Task 2. This task ships zero files; record the no-op outcome in the SUMMARY.

    If ANY expectation fails (e.g., someone reverted a migration, or the codegen drifted), STOP. Do NOT attempt to recreate the STAQPRO-148 infrastructure here — that's out of scope for STAQPRO-333. Open a Linear ticket for the regression and pause this plan. The user expects this task to be a verification gate, not a rebuild.
  </action>
  <verify>
    <automated>
      cd /home/bob/mailbox/dashboard && \
      grep -q "kb_context_refs" test/fixtures/schema.sql && \
      grep -q "kb_context_refs" lib/db/schema.ts && \
      grep -q "kb_documents" scripts/qdrant-bootstrap.ts && \
      grep -q "searchKb" lib/rag/retrieve.ts && \
      grep -q "kb_context_refs" app/api/internal/draft-prompt/route.ts && \
      echo "VERIFY PASS — pre-existing infra intact, Task 1 is no-op"
    </automated>
  </verify>
  <done>
    - All 6 grep checks return the expected matches
    - No files modified in this task
    - SUMMARY records the no-op outcome with the grep evidence
  </done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: getKbPointsByIds helper + extended rag-refs route + seed helper widening</name>
  <files>
    dashboard/lib/rag/kb-qdrant.ts,
    dashboard/app/api/drafts/[id]/rag-refs/route.ts,
    dashboard/test/helpers/db.ts
  </files>
  <behavior>
    Step 1 — Add `getKbPointsByIds` to `dashboard/lib/rag/kb-qdrant.ts`.

    The existing `kb-qdrant.ts` has `upsertKbPoint`, `searchKb`, `deleteKbPointsByDocId`, and the `pointIdFromChunk` UUID derivation. It does NOT have a batch-get-by-IDs surface — that's what this helper adds. Mirror the EXACT shape and error-handling pattern of `getPointsByIds` in `dashboard/lib/rag/qdrant.ts` (lines 217-254), differing only in the collection path:

    ```typescript
    // STAQPRO-333 — fetch KB points by their UUIDs (e.g., the UUIDs stored in
    // drafts.kb_context_refs). Sibling of getPointsByIds in rag/qdrant.ts; same
    // Qdrant batch-get RPC shape, different collection. Used to reverse the
    // one-way pointIdFromChunk hash so the rag-refs route can render the
    // doc_title / excerpt / uploaded_at the drafter saw in the SourcesUsedPanel.
    export interface KbGetPointsResult {
      ok: boolean;
      points: Array<{ id: string; payload: KbPointPayload }>;
      reason?: string;
    }

    export async function getKbPointsByIds(ids: readonly string[]): Promise<KbGetPointsResult> {
      if (ids.length === 0) return { ok: true, points: [] };
      try {
        const r = await qdrantRequest('POST', `/collections/${KB_COLLECTION}/points`, {
          ids: [...ids],
          with_payload: true,
        });
        if (r.status !== 200) {
          return { ok: false, points: [], reason: `HTTP ${r.status}` };
        }
        const result = r.json?.result;
        if (!Array.isArray(result)) {
          return { ok: false, points: [], reason: 'unexpected response shape' };
        }
        const points = result.map((p) => {
          const point = p as { id: string; payload: KbPointPayload };
          return { id: point.id, payload: point.payload };
        });
        return { ok: true, points };
      } catch (error) {
        return {
          ok: false,
          points: [],
          reason: error instanceof Error ? error.message : 'unknown',
        };
      }
    }
    ```

    Step 2 — Extend `dashboard/app/api/drafts/[id]/rag-refs/route.ts`.

    Current route reads only `rag_context_refs` + `rag_retrieval_reason` and resolves against the email collection. Extend to ALSO read `kb_context_refs` and resolve against `kb_documents`.

    Key changes (full target shape — replace the `SourceRef` interface at the top of the file and the `GET` handler body):

    ```typescript
    // dashboard/app/api/drafts/[id]/rag-refs/route.ts
    //
    // STAQPRO-331 #2 + STAQPRO-333 — resolve a draft's RAG context (email refs
    // AND KB refs) back to source documents so the queue UI can render a
    // "Sources used" panel discriminated by source type.
    //
    // drafts.rag_context_refs is a jsonb array of UUIDs in the `email_messages`
    // collection; drafts.kb_context_refs is a jsonb array of UUIDs in the
    // `kb_documents` collection. Each draft can carry both, either, or neither.
    // We batch-resolve each branch independently and tag the response refs
    // with source: 'email' | 'kb' so the client can render appropriately.
    //
    // Per the route's existing semantics: the email branch's rag_retrieval_reason
    // discriminates an empty email refs array (cloud_gated / no_hits / etc).
    // The KB branch does NOT currently have a parallel reason column — see the
    // draft-prompt route comment "rag_retrieval_reason carries the EMAIL
    // retrieval reason for backward-compat with STAQPRO-192's existing eval
    // surface. The KB reason currently lives only in the response body." When
    // kb_context_refs is empty we simply return [] for the kb refs with no
    // companion reason; the UI's "no KB sources retrieved" copy is unconditional.

    import { type NextRequest, NextResponse } from 'next/server';
    import { getKysely } from '@/lib/db';
    import { parseParams } from '@/lib/middleware/validate';
    import { getKbPointsByIds } from '@/lib/rag/kb-qdrant';
    import { getPointsByIds } from '@/lib/rag/qdrant';
    import { idParamSchema } from '@/lib/schemas/common';

    export const dynamic = 'force-dynamic';

    interface EmailSourceRef {
      source: 'email';
      point_id: string;
      message_id: string;
      sender: string;
      recipient: string;
      subject: string | null;
      body_excerpt: string;
      sent_at: string;
      direction: 'inbound' | 'outbound';
      classification_category: string | null;
    }
    interface KbSourceRef {
      source: 'kb';
      point_id: string;
      doc_id: number;
      doc_title: string;
      chunk_index: number;
      mime_type: string;
      excerpt: string;
      uploaded_at: string;
    }
    type SourceRef = EmailSourceRef | KbSourceRef;

    export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
      const p = parseParams(params, idParamSchema);
      if (!p.ok) return p.response;
      const { id } = p.data;

      const db = getKysely();
      const row = await db
        .selectFrom('drafts')
        .select(['rag_context_refs', 'rag_retrieval_reason', 'kb_context_refs'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) {
        return NextResponse.json({ error: 'draft_not_found' }, { status: 404 });
      }

      // jsonb arrays are typed as `unknown` by kysely-codegen; defensively
      // validate each is an array of strings before passing to Qdrant.
      const rawEmailRefs = row.rag_context_refs;
      const emailPointIds = Array.isArray(rawEmailRefs)
        ? rawEmailRefs.filter((r): r is string => typeof r === 'string')
        : [];
      const rawKbRefs = row.kb_context_refs;
      const kbPointIds = Array.isArray(rawKbRefs)
        ? rawKbRefs.filter((r): r is string => typeof r === 'string')
        : [];

      // Two independent Qdrant round-trips in parallel — each can succeed or
      // fail without affecting the other. Empty arrays skip the call (the
      // helper's own empty-input fast-path also handles this; the explicit
      // skip here keeps the response shape predictable and avoids confusing
      // "ok: true with no points" responses in logs).
      const [emailResult, kbResult] = await Promise.all([
        emailPointIds.length > 0 ? getPointsByIds(emailPointIds) : Promise.resolve(null),
        kbPointIds.length > 0 ? getKbPointsByIds(kbPointIds) : Promise.resolve(null),
      ]);

      // Resolve email branch — preserve stored order even if Qdrant returns
      // out-of-order (same invariant the existing email-only path enforced).
      let emailRefs: EmailSourceRef[] = [];
      let qdrant_error: string | undefined;
      let unresolved_point_ids: string[] | undefined;
      if (emailResult) {
        if (emailResult.ok) {
          const byId = new Map(emailResult.points.map((pt) => [pt.id, pt]));
          emailRefs = emailPointIds
            .map((pid) => byId.get(pid))
            .filter((pt): pt is { id: string; payload: typeof emailResult.points[number]['payload'] } => pt !== undefined)
            .map((pt) => ({
              source: 'email' as const,
              point_id: pt.id,
              message_id: pt.payload.message_id,
              sender: pt.payload.sender,
              recipient: pt.payload.recipient,
              subject: pt.payload.subject,
              body_excerpt: pt.payload.body_excerpt,
              sent_at: pt.payload.sent_at,
              direction: pt.payload.direction,
              classification_category: pt.payload.classification_category,
            }));
        } else {
          qdrant_error = emailResult.reason ?? 'unknown';
          unresolved_point_ids = emailPointIds;
        }
      }

      // Resolve KB branch — same ordering invariant, separate failure
      // surface (kb_qdrant_error / kb_unresolved_point_ids).
      let kbRefs: KbSourceRef[] = [];
      let kb_qdrant_error: string | undefined;
      let kb_unresolved_point_ids: string[] | undefined;
      if (kbResult) {
        if (kbResult.ok) {
          const byId = new Map(kbResult.points.map((pt) => [pt.id, pt]));
          kbRefs = kbPointIds
            .map((pid) => byId.get(pid))
            .filter((pt): pt is { id: string; payload: typeof kbResult.points[number]['payload'] } => pt !== undefined)
            .map((pt) => ({
              source: 'kb' as const,
              point_id: pt.id,
              doc_id: pt.payload.doc_id,
              doc_title: pt.payload.doc_title,
              chunk_index: pt.payload.chunk_index,
              mime_type: pt.payload.mime_type,
              excerpt: pt.payload.excerpt,
              uploaded_at: pt.payload.uploaded_at,
            }));
        } else {
          kb_qdrant_error = kbResult.reason ?? 'unknown';
          kb_unresolved_point_ids = kbPointIds;
        }
      }

      // Ordering: email first (in stored order), KB second (in stored order).
      // Mirrors the prompt-assembly block ordering in lib/drafting/prompt.ts.
      const refs: SourceRef[] = [...emailRefs, ...kbRefs];

      return NextResponse.json({
        reason: row.rag_retrieval_reason,
        refs,
        ...(qdrant_error ? { qdrant_error, unresolved_point_ids } : {}),
        ...(kb_qdrant_error ? { kb_qdrant_error, kb_unresolved_point_ids } : {}),
      });
    }
    ```

    Notes on the existing 4 test cases (cases at lines 492-608 of `drafts.test.ts`):
    - `returns 404 for nonexistent draft` — unchanged. The select now requests 3 columns; if the row is missing, the early return still fires.
    - `returns reason + empty refs when rag_context_refs is empty (no Qdrant call)` — relies on `kb_context_refs` also being empty (default `[]` on insert). seedDraft only sets rag refs today; the kb_context_refs column default `'[]'::jsonb` from migration 014 means seeds that don't specify kb refs naturally produce kb-empty drafts. The "no Qdrant call" assertion `expect(fetchSpy.mock.calls.length).toBe(callsBefore)` STILL HOLDS because both arms skip the fetch when the array is empty.
    - `resolves stored point IDs to Qdrant payloads and preserves stored ORDER` — currently mocks ONE fetch call (Qdrant batch-get for email). The route now performs Promise.all of TWO potential calls; when kb_context_refs is empty, only the email call fires (still ONE fetch), so the existing `mockImplementationOnce` still works. The test assertion `body.refs[0].point_id === A` still holds — emailRefs maps to a SourceRef[] where each entry has the EmailSourceRef shape (which still has `point_id` and `message_id`). The test does NOT assert against `source: 'email'`, so it does not regress. (Optional: extend the test to add `expect(body.refs[0].source).toBe('email')` for tighter coverage — RECOMMENDED but the test still passes without it.)
    - `returns qdrant_error + unresolved_point_ids when Qdrant is unreachable` — currently mocks ONE 503 fetch. With kb_context_refs empty, the route still only fires ONE email-side fetch. Existing assertions hold unchanged.

    Step 3 — Widen `dashboard/test/helpers/db.ts:SeedOpts` and `seedDraft` to accept `kbContextRefs`.

    Mirror the exact pattern used for `ragContextRefs`:

    ```typescript
    // In SeedOpts interface (after ragRetrievalReason — currently line ~45):
    // STAQPRO-333 — seed KB refs alongside email refs so rag-refs route tests
    // can exercise the kb-context-refs resolution path. Same jsonb shape as
    // rag_context_refs; default [].
    kbContextRefs?: readonly string[];
    ```

    Update seedDraft INSERT to include the new column:

    ```typescript
    // Add near the top of seedDraft (alongside ragContextRefs default):
    const kbContextRefs = opts.kbContextRefs ?? [];

    // Add to the INSERT column list (after rag_retrieval_reason):
    //   ...
    //   rag_context_refs, rag_retrieval_reason, kb_context_refs)
    // And to the VALUES list (after $9):
    //   ...
    //   $8::jsonb, $9, $10::jsonb)
    // And to the parameters:
    //   ...
    //   JSON.stringify([...ragContextRefs]),
    //   ragRetrievalReason,
    //   JSON.stringify([...kbContextRefs]),
    // ],
    ```

    The current INSERT is at lines 69-91 of `test/helpers/db.ts`. Modify the SQL string and the parameter array in place; preserve the existing parameter numbering by appending `$10` only — do not renumber.

    Step 4 — Run typecheck + lint + tests.

    ```bash
    cd /home/bob/mailbox/dashboard
    npm run typecheck   # must pass; the discriminated union widening is the riskiest typing surface
    npm run lint        # biome; existing style is established
    npm test -- --run   # vitest; existing rag-refs cases must still pass (skipped without TEST_POSTGRES_URL)
    ```

    No new tests in this task — Task 3 adds the kb-specific test cases. This task's verification is: existing tests still pass, typecheck holds, build (next build) succeeds (run as part of typecheck step if biome+tsc are not enough; the `dashboard/CLAUDE.md` Tests section documents the canonical command set).
  </behavior>
  <action>
    Execute the 4 steps in order:

    1. Append `getKbPointsByIds` to `dashboard/lib/rag/kb-qdrant.ts` per the code block above. Add a top-of-file comment update referencing STAQPRO-333 if the existing header doesn't already note STAQPRO-148 lineage (read the existing header first — current header at lines 1-15 references STAQPRO-148; add a one-line "STAQPRO-333 — adds getKbPointsByIds for rag-refs surface" note OR put it inline above the new function).

    2. Replace `dashboard/app/api/drafts/[id]/rag-refs/route.ts` content with the full target shape above. The replacement is full-file because the SourceRef type is a discriminated union now and partial edits would be harder to review than a clean rewrite. Preserve the existing top-of-file comment style and lineage references — add a STAQPRO-333 line to the docblock.

    3. Update `dashboard/test/helpers/db.ts` per step 3 — add `kbContextRefs` to SeedOpts, default to `[]`, append to INSERT column list and parameters as `$10`. Mirror the existing `ragContextRefs` pattern exactly.

    4. Run the verification commands:
       ```bash
       cd /home/bob/mailbox/dashboard
       npm run typecheck
       npm run lint
       npm test -- --run 2>&1 | tail -40
       ```
       Confirm the 4 existing rag-refs cases still pass (DB-backed cases will skip cleanly without TEST_POSTGRES_URL — that's expected and not a regression). If any existing case fails, STOP and diagnose before proceeding to Task 3.

    Constraint: do NOT touch `lib/rag/retrieve.ts`, `app/api/internal/draft-prompt/route.ts`, or any migration file — those are pre-existing STAQPRO-148 surfaces and this plan does NOT modify them.
  </action>
  <verify>
    <automated>
      cd /home/bob/mailbox/dashboard && \
      npm run typecheck && \
      npm run lint && \
      npm test -- --run 2>&1 | tail -40 && \
      grep -q "export async function getKbPointsByIds" lib/rag/kb-qdrant.ts && \
      grep -q "source: 'email'" app/api/drafts/\[id\]/rag-refs/route.ts && \
      grep -q "source: 'kb'" app/api/drafts/\[id\]/rag-refs/route.ts && \
      grep -q "kbContextRefs" test/helpers/db.ts
    </automated>
  </verify>
  <done>
    - `getKbPointsByIds` exported from `dashboard/lib/rag/kb-qdrant.ts` mirroring the email-side `getPointsByIds` signature/error-handling
    - `dashboard/app/api/drafts/[id]/rag-refs/route.ts` returns a discriminated `SourceRef[]` with both email and kb branches, partial-Qdrant-failure handling for each side independently, stored-order preservation per source
    - `dashboard/test/helpers/db.ts:SeedOpts` accepts `kbContextRefs`; seedDraft writes the column
    - `npm run typecheck && npm run lint && npm test -- --run` all green
    - All 4 existing rag-refs test cases continue to pass (skipped without DB_URL, expected)
  </done>
</task>

<task type="auto" tdd="false">
  <name>Task 3: SourcesUsedPanel KB branch + 2 new test cases</name>
  <files>
    dashboard/components/SourcesUsedPanel.tsx,
    dashboard/test/routes/drafts.test.ts
  </files>
  <behavior>
    Step 1 — Extend `dashboard/components/SourcesUsedPanel.tsx`.

    Widen the local `SourceRef` interface to the discriminated union matching the route. Update `RagRefsResponse` to also carry the optional `kb_qdrant_error` / `kb_unresolved_point_ids` fields. Branch the render in `SourcesContent` by `ref.source`.

    Target shape of the component types and the render branch:

    ```typescript
    interface EmailSourceRef {
      source: 'email';
      point_id: string;
      message_id: string;
      sender: string;
      recipient: string;
      subject: string | null;
      body_excerpt: string;
      sent_at: string;
      direction: 'inbound' | 'outbound';
      classification_category: string | null;
    }
    interface KbSourceRef {
      source: 'kb';
      point_id: string;
      doc_id: number;
      doc_title: string;
      chunk_index: number;
      mime_type: string;
      excerpt: string;
      uploaded_at: string;
    }
    type SourceRef = EmailSourceRef | KbSourceRef;

    interface RagRefsResponse {
      reason: string;
      refs: SourceRef[];
      qdrant_error?: string;
      unresolved_point_ids?: string[];
      kb_qdrant_error?: string;
      kb_unresolved_point_ids?: string[];
    }
    ```

    In the `<button>` toggle: compute counts and breakdown:

    ```typescript
    const emailCount = data?.refs.filter((r) => r.source === 'email').length ?? 0;
    const kbCount = data?.refs.filter((r) => r.source === 'kb').length ?? 0;
    const totalCount = data ? emailCount + kbCount : null;
    ```

    Chip behavior:
    - If `totalCount === null` → no chip (loading)
    - Else show the total in the existing chip styling (one number)
    - The breakdown ("3 email · 2 kb" or "2 kb only" etc.) goes in a small line inside the panel body header (above the `<ul>`), NOT in the chip. Format string suggestion: when both nonzero, `"{emailCount} email · {kbCount} kb"`; when one is zero, just `"{n} {source}"`; when both zero, the existing "No sources retrieved" copy still wins.

    In `<SourcesContent>` switch the `<li>` render on `ref.source`:

    ```typescript
    {data.refs.map((ref) => (
      <li key={ref.point_id} className="rounded border border-border-subtle bg-bg-panel p-2">
        {ref.source === 'email' ? (
          /* existing email render — unchanged */
        ) : (
          /* new KB render */
          <>
            <div className="mb-1 flex items-baseline gap-2">
              <span
                className="rounded-full border border-accent-purple/40 bg-accent-purple/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent-purple"
              >
                KB
              </span>
              <span className="truncate font-mono text-xs text-ink-muted">
                {ref.doc_title}
              </span>
              <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-ink-dim">
                uploaded <TimeAgo iso={ref.uploaded_at} />
              </span>
            </div>
            <p className="font-sans text-xs leading-relaxed text-ink-muted">
              {truncate(ref.excerpt, 240)}
            </p>
          </>
        )}
      </li>
    ))}
    ```

    Accent token verification (per D-6): before writing the KB chip styles, run `grep -rn "accent-purple\\|accent-green" dashboard/tailwind.config.ts dashboard/app/globals.css dashboard/components/` to confirm which is defined. If both are defined, prefer `accent-purple`. If only one is, use it. If neither exists, define it in the Tailwind config (`dashboard/tailwind.config.ts`) — extend `theme.extend.colors` with `'accent-purple': '#a78bfa'` (Tailwind's purple-400; the existing palette uses 400-level accents per the inbound/outbound blue). The accent-blue token IS already defined per the existing inbound-chip's `border-accent-blue/40 bg-accent-blue/10 text-accent-blue` pattern; mirror that exactly for accent-purple.

    Partial-failure surface: extend the existing `data.qdrant_error && data.unresolved_point_ids && ...` warning block to ALSO render a parallel warning for KB:

    ```typescript
    {data.kb_qdrant_error && data.kb_unresolved_point_ids && data.kb_unresolved_point_ids.length > 0 && (
      <p className="font-sans text-xs text-accent-orange">
        ⚠ KB Qdrant unreachable ({data.kb_qdrant_error}); {data.kb_unresolved_point_ids.length} KB ref
        {data.kb_unresolved_point_ids.length === 1 ? '' : 's'} could not be resolved right now.
      </p>
    )}
    ```

    These warning blocks live inside `<SourcesContent>` in the empty-refs branch today. If refs[] is non-empty but kb_qdrant_error is set (mixed-success case), the warning should ALSO render — move both warnings out of the empty-refs-only block into a top-level conditional that fires whenever the error fields are set. The cleanest refactor:

    ```typescript
    function SourcesContent({ data }: { data: RagRefsResponse }) {
      const errorBlock = (
        <>
          {data.qdrant_error && data.unresolved_point_ids && data.unresolved_point_ids.length > 0 && (
            <p className="font-sans text-xs text-accent-orange">
              ⚠ Email Qdrant unreachable ({data.qdrant_error}); {data.unresolved_point_ids.length} email ref
              {data.unresolved_point_ids.length === 1 ? '' : 's'} could not be resolved right now.
            </p>
          )}
          {data.kb_qdrant_error && data.kb_unresolved_point_ids && data.kb_unresolved_point_ids.length > 0 && (
            <p className="font-sans text-xs text-accent-orange">
              ⚠ KB Qdrant unreachable ({data.kb_qdrant_error}); {data.kb_unresolved_point_ids.length} KB ref
              {data.kb_unresolved_point_ids.length === 1 ? '' : 's'} could not be resolved right now.
            </p>
          )}
        </>
      );

      if (data.refs.length === 0) {
        return (
          <div className="space-y-1">
            <p className="font-sans text-xs text-ink-muted">No sources retrieved for this draft.</p>
            <p className="font-sans text-xs text-ink-dim">
              Reason: <span className="font-mono text-ink-muted">{data.reason}</span>
              {REASON_LABEL[data.reason] && (
                <span className="ml-1 text-ink-dim">— {REASON_LABEL[data.reason]}</span>
              )}
            </p>
            {errorBlock}
          </div>
        );
      }

      const emailCount = data.refs.filter((r) => r.source === 'email').length;
      const kbCount = data.refs.filter((r) => r.source === 'kb').length;
      const breakdown =
        emailCount > 0 && kbCount > 0
          ? `${emailCount} email · ${kbCount} kb`
          : emailCount > 0
          ? `${emailCount} email`
          : `${kbCount} kb`;

      return (
        <div className="space-y-2">
          <p className="font-sans text-[11px] uppercase tracking-wider text-ink-dim">{breakdown}</p>
          {errorBlock}
          <ul className="space-y-2">
            {/* ... map per the discriminated render above ... */}
          </ul>
        </div>
      );
    }
    ```

    Note: the existing first-line "Email Qdrant unreachable" wording change from "Qdrant unreachable" tightens the existing copy now that there are two possible Qdrant failures to discriminate. Update the existing test case (`returns qdrant_error + unresolved_point_ids when Qdrant is unreachable`) is route-side only and does not assert against panel copy — safe to change.

    Also update `REASON_LABEL` block: the existing labels are email-specific (`cloud_gated`, `no_hits`, etc); keep them as-is. The KB branch contributes refs but the route response's `reason` field still carries the EMAIL reason (per the route comment and D-5). No new REASON_LABEL entries needed.

    Step 2 — Add 2 new test cases in `dashboard/test/routes/drafts.test.ts` inside the existing `describe('GET /api/drafts/[id]/rag-refs', ...)` block (after the existing 4 cases, before the closing brace at line ~609).

    Test case 5: KB-only draft (no email refs, 2 kb refs).

    ```typescript
    it('resolves KB refs against the kb_documents collection (source-tagged, kb-only draft)', async () => {
      const KA = '44444444-4444-4444-8444-444444444444';
      const KB = '55555555-5555-4555-8555-555555555555';
      const seed = await seedDraft({
        ragContextRefs: [], // no email refs
        kbContextRefs: [KA, KB], // 2 kb refs in stored order
        ragRetrievalReason: 'no_hits', // email side had no hits
      });
      const fetchSpy = vi.mocked(global.fetch);
      // Only ONE fetch fires (KB batch-get) — email side has zero refs so skips.
      fetchSpy.mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              result: [
                {
                  id: KA,
                  payload: {
                    doc_id: 101,
                    chunk_index: 3,
                    doc_title: 'pricing-2026.pdf',
                    doc_sha256: 'abc',
                    mime_type: 'application/pdf',
                    excerpt: 'Standard rate is $0.42/unit; bulk over 1000 is $0.38/unit.',
                    uploaded_at: '2026-05-01T09:00:00Z',
                  },
                },
                {
                  id: KB,
                  payload: {
                    doc_id: 102,
                    chunk_index: 0,
                    doc_title: 'refund-policy.md',
                    doc_sha256: 'def',
                    mime_type: 'text/markdown',
                    excerpt: 'Refunds within 30 days of delivery, no questions asked.',
                    uploaded_at: '2026-05-02T10:00:00Z',
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      );
      try {
        const { GET } = await import('@/app/api/drafts/[id]/rag-refs/route');
        const res = await GET(fakeRequest(), { params: { id: String(seed.draftId) } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.reason).toBe('no_hits'); // email reason carried through
        expect(body.refs).toHaveLength(2);
        expect(body.refs[0]).toMatchObject({
          source: 'kb',
          point_id: KA,
          doc_id: 101,
          doc_title: 'pricing-2026.pdf',
          chunk_index: 3,
        });
        expect(body.refs[1]).toMatchObject({
          source: 'kb',
          point_id: KB,
          doc_id: 102,
          doc_title: 'refund-policy.md',
        });
      } finally {
        await deleteSeededDraft(seed);
      }
    });
    ```

    Test case 6: Mixed email + KB draft (1 email ref, 1 kb ref; both Qdrant calls fire, response interleaves email-first then kb).

    ```typescript
    it('resolves a mixed draft (email + kb refs) with email-first stable ordering', async () => {
      const E = '66666666-6666-4666-8666-666666666666';
      const K = '77777777-7777-4777-8777-777777777777';
      const seed = await seedDraft({
        ragContextRefs: [E],
        kbContextRefs: [K],
        ragRetrievalReason: 'ok',
      });
      const fetchSpy = vi.mocked(global.fetch);
      // Two fetches fire — order depends on Promise.all internals. Mock both
      // with mockImplementation (sticky) so either call order works.
      fetchSpy.mockImplementation((url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (u.includes('/collections/email_messages/points')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                result: [
                  {
                    id: E,
                    payload: {
                      message_id: 'msg-E',
                      sender: 'e@example.com',
                      recipient: 'op@example.com',
                      subject: 'subject E',
                      body_excerpt: 'body excerpt E',
                      sent_at: '2026-05-03T12:00:00Z',
                      direction: 'inbound',
                      classification_category: 'inquiry',
                    },
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (u.includes('/collections/kb_documents/points')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                result: [
                  {
                    id: K,
                    payload: {
                      doc_id: 200,
                      chunk_index: 1,
                      doc_title: 'SOP-onboarding.pdf',
                      doc_sha256: 'xyz',
                      mime_type: 'application/pdf',
                      excerpt: 'Onboarding takes ~30 days from signed agreement.',
                      uploaded_at: '2026-04-15T14:00:00Z',
                    },
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response('unexpected URL', { status: 500 }));
      });
      try {
        const { GET } = await import('@/app/api/drafts/[id]/rag-refs/route');
        const res = await GET(fakeRequest(), { params: { id: String(seed.draftId) } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.reason).toBe('ok');
        expect(body.refs).toHaveLength(2);
        // Email-first ordering invariant (D-3 in the plan).
        expect(body.refs[0].source).toBe('email');
        expect(body.refs[0].point_id).toBe(E);
        expect(body.refs[1].source).toBe('kb');
        expect(body.refs[1].point_id).toBe(K);
        expect(body.refs[1].doc_title).toBe('SOP-onboarding.pdf');
      } finally {
        await deleteSeededDraft(seed);
        // Reset fetch mock back to the suite's beforeAll default for any
        // following tests outside this describe block.
        vi.mocked(global.fetch).mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
        );
      }
    });
    ```

    Step 3 — Verify.

    ```bash
    cd /home/bob/mailbox/dashboard
    npm run typecheck
    npm run lint
    npm test -- --run 2>&1 | tail -40
    ```

    The 2 new cases will skip without TEST_POSTGRES_URL (consistent with the existing DB-backed cases). When run against a real Postgres, they should pass alongside the existing 4. Total cases in the rag-refs describe block: 6.
  </behavior>
  <action>
    1. Read `dashboard/components/SourcesUsedPanel.tsx` once to confirm the current shape (it was already read at planning time; re-read to be safe before editing).

    2. Verify accent-purple is in the Tailwind config (`grep -rn 'accent-purple' dashboard/tailwind.config.ts dashboard/app/globals.css 2>&1`). If absent, add it under `theme.extend.colors` in `tailwind.config.ts` — mirror the existing accent-blue entry's shape. If the config uses a different key naming pattern, mirror that.

    3. Rewrite `dashboard/components/SourcesUsedPanel.tsx` with:
       - Widened `SourceRef` discriminated union
       - Widened `RagRefsResponse` with `kb_qdrant_error` / `kb_unresolved_point_ids`
       - Refactored `<SourcesContent>` per the behavior block (error-block extracted, breakdown line, discriminated `<li>` render)
       - "Email Qdrant unreachable" copy update on the existing error block

    4. Append the 2 new test cases to `dashboard/test/routes/drafts.test.ts` inside the existing `describe('GET /api/drafts/[id]/rag-refs', ...)` block.

    5. Run typecheck + lint + tests:
       ```bash
       cd /home/bob/mailbox/dashboard
       npm run typecheck
       npm run lint
       npm test -- --run 2>&1 | tail -50
       ```

    6. If a live TEST_POSTGRES_URL is reachable (via the Tailscale tunnel pattern documented in `dashboard/CLAUDE.md` Tests section), run the 6 rag-refs cases for real. If not, document the skipped-set in the SUMMARY and let CI run them.

    Constraint: do NOT change anything in `lib/rag/retrieve.ts`, `app/api/internal/draft-prompt/route.ts`, `migrations/`, `scripts/qdrant-bootstrap.ts`, or any of the `lib/rag/kb-*` files OTHER than the `getKbPointsByIds` addition in Task 2. STAQPRO-148 already did that work and this plan must NOT regress it.
  </action>
  <verify>
    <automated>
      cd /home/bob/mailbox/dashboard && \
      npm run typecheck && \
      npm run lint && \
      npm test -- --run 2>&1 | tail -50 && \
      grep -q "source: 'email'" components/SourcesUsedPanel.tsx && \
      grep -q "source: 'kb'" components/SourcesUsedPanel.tsx && \
      grep -q "kbContextRefs:" test/routes/drafts.test.ts && \
      grep -c "describe('GET /api/drafts/\\[id\\]/rag-refs'" test/routes/drafts.test.ts
    </automated>
    Manual verification (local dev or staging — optional, post-deploy is fine):
    - `cd dashboard && npm run dev` → http://localhost:3001/dashboard/queue
    - Open a draft that has both email + kb refs (use the live appliance, or seed locally via psql)
    - Expand "Sources used" — verify breakdown line shows "{n} email · {m} kb"
    - Confirm KB refs render with the KB chip + filename + uploaded-ago + excerpt
    - Confirm email refs render unchanged
  </verify>
  <done>
    - `dashboard/components/SourcesUsedPanel.tsx` renders both email and KB refs with discriminated styling; combined-count chip + per-source breakdown line in panel body; partial-Qdrant-failure warnings for both sides
    - 2 new cases in `dashboard/test/routes/drafts.test.ts` rag-refs describe block (kb-only path + mixed path)
    - `npm run typecheck && npm run lint && npm test -- --run` all green
    - All 6 rag-refs cases pass (existing 4 + new 2) when run against a real Postgres; cleanly skip without
  </done>
</task>

</tasks>

<verification>
After all 3 tasks:

1. **No regression on the STAQPRO-148 KB pipeline**: The migration 014 archive trigger still carries kb_context_refs onto sent_history. The draft-prompt route still persists kb_context_refs. The retrieve.ts merge still returns kb_refs / kb_reason. Task 1's verification grep checks confirm these pre-existing invariants on the branch before any edits.

2. **Discriminated-union typing holds**: `npm run typecheck` proves the SourceRef union narrows correctly in both the route (server-side construction) and the panel (client-side render). Any drift between the route's emitted shape and the panel's interface fails at compile time.

3. **Partial-failure isolation**: If KB Qdrant is unreachable while email Qdrant succeeds, the route returns 200 with email refs resolved and `kb_qdrant_error` + `kb_unresolved_point_ids` set. The panel renders email refs normally with a KB-side warning. (Symmetric for the reverse case — already implemented for email-side.)

4. **Stored-order preservation**: Test case 3 ("preserves stored ORDER") already proves this for email; the kb branch uses the same `byId = new Map(...)` then `pointIds.map(id => byId.get(id))` pattern, so the invariant transfers. New test case 6 explicitly asserts email-first then kb in the merged refs array (D-3 in the design decisions).

5. **Future-compat for STAQPRO-332 (Drive RAG)**: When Drive lands, the SourceRef discriminator gains a third value `'drive'`. The route gains a third Qdrant collection call + third error surface. The panel gains a third `<li>` render branch. No type changes propagate beyond those three sites — the discriminated-union pattern is the right shape.

6. **kb_retrieval_reason explicitly NOT added in this plan**: Captured in D-5 + the prerequisites. When the eval surface starts caring about KB hit-rate, a separate plan adds the column + reason carrier; this plan's response keeps `reason` as email-only by intent.

Deployment checklist (for SUMMARY, NOT executed in this plan since no migration is involved):
- Merge PR
- On mailbox1: `git pull && docker compose up -d --build mailbox-dashboard --remove-orphans`
- On mailbox2: same
- NO migrate profile run needed — this plan ships zero migrations
- NO qdrant-bootstrap re-run needed — collections already exist on both appliances
- Spot-check on each appliance:
  - Open a draft in `/dashboard/queue`
  - Expand "Sources used"
  - If the operator has uploaded KB docs AND a draft was assembled after they uploaded, the kb refs should appear
  - If no kb refs appear, check `mailbox.drafts.kb_context_refs` for the draft id — if it's `[]`, the upstream retrieval returned no KB hits (expected for a KB corpus that's empty or doesn't match the inbound topically); if it's non-empty but the panel shows zero KB refs, that's a Qdrant resolution issue and `kb_qdrant_error` should surface in the response
</verification>

<success_criteria>
- `dashboard/lib/rag/kb-qdrant.ts` exports `getKbPointsByIds` mirroring the email-side `getPointsByIds`
- `dashboard/app/api/drafts/[id]/rag-refs/route.ts` returns a discriminated SourceRef[] with email + kb branches
- `dashboard/components/SourcesUsedPanel.tsx` renders both branches with distinct visual treatment + combined-count + per-source breakdown
- 2 new tests cover the KB-only and mixed-source paths; the 4 existing tests still pass unchanged
- `npm run typecheck`, `npm run lint`, `npm test -- --run` all green
- Zero migrations, zero new env vars, zero new npm deps, zero new Qdrant collections — every backend prereq already exists per STAQPRO-148
- The "what's actually missing" surface that the task-scope brief identified (rag-refs route + SourcesUsedPanel) is what this plan ships; the rest of the brief's task list was already shipped under STAQPRO-148 and is verified intact in Task 1
</success_criteria>

<scope_correction_note>
The original task-scope brief (in the planner prompt) assumed STAQPRO-333 was a greenfield KB-sidecar build (migration 024, kb_chunks collection, new chunker/extractors, new env vars, new npm deps, retrieval merge, delete cascade, etc). Read of the current branch shows that work was ALREADY DONE under STAQPRO-148 — migration 014, `kb_documents` collection (not `kb_chunks`), `kb-chunker.ts` + `kb-parsers.ts` + `kb-ingest.ts`, full upload + delete cascade, retrieval merge in `retrieve.ts`, `drafts.kb_context_refs` persistence in `draft-prompt/route.ts`, archival trigger in migration 014. The actual delta for STAQPRO-333 is JUST the user-visible surfacing: rag-refs route resolution of kb_context_refs + SourcesUsedPanel KB branch. This plan corrects the scope and ships the actual gap. If the user wants the larger scope re-treated as a follow-on (e.g., a Drive-aware RAG STAQPRO-332 redo, or a kb_retrieval_reason column for eval, or a sweeper for >2MB files), those are separate Linear tickets and not part of this PR.

Commit structure (atomic per Eric's git conventions):
- C1: `feat(rag): add getKbPointsByIds for KB batch-resolve in rag/kb-qdrant.ts (STAQPRO-333)` — kb-qdrant.ts only
- C2: `feat(api): extend /api/drafts/[id]/rag-refs to resolve kb_context_refs (STAQPRO-333)` — route.ts + test/helpers/db.ts widening
- C3: `feat(ui): render KB refs in SourcesUsedPanel + 2 new tests (STAQPRO-333)` — SourcesUsedPanel.tsx + drafts.test.ts cases 5+6
</scope_correction_note>

<output>
After completion:
1. Commit on the existing `feat/staqpro-333-kb-sidecar-rag` branch (do NOT create a new branch).
2. Write SUMMARY to `.planning/quick/260512-fwy-staqpro-333-kb-sidecar-rag-chunker-extra/260512-fwy-SUMMARY.md` covering:
   - Task 1's no-op verification outcome (grep evidence that STAQPRO-148 infra is intact)
   - What shipped in Tasks 2-3
   - Files changed
   - Test results (incl. which DB-backed cases ran vs skipped)
   - Deployment notes (no migration profile run needed; just `docker compose up -d --build mailbox-dashboard --remove-orphans` on both appliances)
   - "Out of scope — deferred to follow-up tickets" list:
     - kb_retrieval_reason column for eval surface — separate ticket when eval needs it
     - Sweeper for >2MB KB files (currently inline-only) — separate ticket
     - Drive-aware RAG (STAQPRO-332) — separate ticket
     - KB folder/tag organization — separate ticket
     - Versioning on KB re-upload — separate ticket
     - Per-document cloud opt-out — separate ticket
3. Open a PR against `master` referencing STAQPRO-333 in the title and body; explicitly note "the original issue's task list was substantially pre-shipped under STAQPRO-148; this PR ships the user-visible surface gap (rag-refs route + SourcesUsedPanel KB branch)."
</output>
