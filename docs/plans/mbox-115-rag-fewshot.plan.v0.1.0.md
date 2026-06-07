# MBOX-115 — Retrieval-Augmented Few-Shot (Dynamic Exemplar Selection): Implementation Plan

**Version:** v0.1.0
**Date:** 2026-05-28
**Status:** Planning (not started)
**Parent epic:** MBOX-111 (M5 — Draft Quality Roadmap) → roll-up STAQPRO-336
**Branch (work):** `dustin/mbox-115`

> **TL;DR** — MBOX-115 upgrades the *static* sent-history exemplar mining (already shipped as `lib/drafting/exemplars.ts`, STAQPRO-234) into *dynamic, similarity-retrieved* few-shot selection. The retrieval substrate (Qdrant `email_messages`, `retrieveForDraft`, the `exemplar_refs` prompt slot + audit column) **already exists**; this ticket replaces the "k most-recent per category" SQL with "k most-similar `(inbound, approved-reply)` pairs by embedding," adds MMR diversity, and falls back to the static path below a corpus-size threshold. The single biggest open question is **whether to retrieve exemplars from the existing `email_messages` collection (reusing the outbound embeddings already ingested) or stand up the per-customer `customer_sent_corpus_<id>` collection the ticket specifies** — the former ships in days with zero new infra; the latter matches the ticket text but duplicates data.

---

## 1. Goal + acceptance (restated)

Replace static hand-curated / recency-mined few-shot examples with **dynamically retrieved** examples: for each inbound, embed it, retrieve the 3-5 most semantically-similar prior `(inbound, approved-reply)` pairs from the customer's history, inject as few-shot examples into the drafting prompt, generate.

**Deliverables (from MBOX-115):**

- [ ] Customer sent-corpus embedding pipeline (bulk import + ongoing append on every approved draft)
- [ ] Qdrant collection schema: `(inbound_text, reply_text, embedding, timestamp, classification)`
- [ ] Diversity-aware top-k retrieval (greedy MMR or equivalent)
- [ ] n8n workflow updated: retrieve → inject few-shot → drop into drafting prompt
- [ ] Empty-pool fallback to static examples (STAQPRO-341) below a configurable threshold (~20 approved drafts)
- [ ] Eval comparing static vs dynamic (§5.8 trace set)
- [ ] Document KV-cache interaction with STAQPRO-347

**Properties to preserve:** "strictly stronger than static," "improves monotonically with use," "minimize cloud" doctrine (retrieval is local-only by default), and the existing privacy gate.

---

## 2. What already exists in the codebase

The "substrate is the static few-shot infra" assumption in the ticket is correct — and it's richer than the ticket's "STAQPRO-341 static hand-curated" framing. Three distinct exemplar/RAG layers already ship:

### 2.1 Static exemplar mining (STAQPRO-234) — the thing being replaced

| Piece | File | Behavior |
|---|---|---|
| Mining query | `dashboard/lib/drafting/exemplars.ts` → `getCategoryExemplars(category, k, persona_key?)` | **`SELECT ... FROM mailbox.sent_history WHERE classification_category = $cat ORDER BY sent_at DESC LIMIT k`.** Pure recency, no similarity. Returns `{message_id, snippet, sent_at, subject}[]`. Fails closed (empty → caller falls back to RAG). |
| Audit column | `dashboard/migrations/020-drafts-exemplar-refs-v1-2026-05-05.sql` | `drafts.exemplar_refs` + `sent_history.exemplar_refs` (jsonb arrays of `sent_history.message_id` strings — NOT Qdrant UUIDs, deliberately kept separate from `rag_context_refs`). Archival trigger carries them through. |
| Prompt slot | `dashboard/lib/drafting/prompt.ts` → `assemblePrompt({... exemplar_refs?})` (L48-53) | Distinct prompt section: "Past replies you've sent for this kind of message." Separate from `rag_refs` (vector-similar emails) and `kb_refs` (SOPs). |
| Wiring | `dashboard/app/api/internal/draft-prompt/route.ts` | Calls `getCategoryExemplars(category, 1, DEFAULT_PERSONA_KEY)` in a `Promise.all` alongside `retrieveForDraft` + `getThreadHistory`. Default **k=1**. Persists `exemplar_refs = [message_id...]`. |

**This is the seam.** MBOX-115 swaps `getCategoryExemplars`'s recency SQL for similarity retrieval. The prompt slot, audit column, writeback, and graceful-degrade contract are all already in place — they do not change.

### 2.2 RAG retrieval substrate (STAQPRO-190/191) — reusable engine

| Piece | File | Behavior |
|---|---|---|
| Draft-time retrieval | `dashboard/lib/rag/retrieve.ts` → `retrieveForDraft(...)` | Embeds inbound, queries Qdrant `email_messages` with sender filter, returns top-k `RetrievalRef[]` + `reason`. Privacy gate (LOCAL always; CLOUD only `RAG_CLOUD_ROUTE_ENABLED=1`). Returns empty on any failure. |
| Qdrant client | `dashboard/lib/rag/qdrant.ts` | Collection `email_messages` (768d/Cosine). `searchByVector(opts)` with `senderFilter`/`recipientFilter`/`personaKey`/`excludePointId`/`excludeThreadId`. `pointIdFromMessageId` (deterministic UUID). Tagged-result, never throws. |
| Embeddings | `dashboard/lib/rag/embed.ts` → `embedText()` | nomic-embed-text v1.5, 768d. |
| Excerpting | `dashboard/lib/rag/excerpt.ts` | `buildBodyExcerpt`, `buildEmbeddingInput`, `stripQuotedHistory`. |
| Ingestion | `dashboard/app/api/internal/embed/route.ts`, `inbox-messages` POST (fire-and-forget) | **Outbound replies are ALREADY embedded into `email_messages`** with `direction:'outbound'`, `classification_category`, on every Mark-Sent (per CLAUDE.md RAG ingestion section). |
| Backfill | `dashboard/scripts/rag-backfill.ts` | One-shot, 90-day default lookback, memory-pre-flight guarded. |
| Bootstrap | `dashboard/scripts/qdrant-bootstrap.ts` | Declares collections. `email_messages` + `kb_documents`. |

**Critical observation:** the customer's sent corpus is *already in Qdrant* as `direction:'outbound'` points in `email_messages`. The ticket's proposed `customer_sent_corpus_<id>` collection would largely duplicate this. See §5 Q1.

### 2.3 Eval surface (STAQPRO-192/340)

| Piece | File | Use |
|---|---|---|
| RAG edit-rate baseline | `dashboard/lib/rag/eval-baseline.ts` → `RAG_BASELINE`, `buildRagEvalSnapshot` | Frozen pre-RAG edit-rate; live 7d delta on `/status`. "Helping" = ≥15% relative edit-rate reduction over 14d. |
| Trace set / bake-off | `dashboard/lib/eval/trace-set.ts`, `dashboard/lib/eval/bake-off.ts` | §5.8 trace set harness for static-vs-dynamic comparison (the ticket's eval deliverable). |

### 2.4 Summary: what is net-new

| Deliverable | Exists? | Net-new work |
|---|---|---|
| Sent-corpus embedded | ✅ (`email_messages`, `direction:outbound`) | Possibly nothing (reuse) — see Q1 |
| `(inbound, reply)` pairing | ❌ | **Pairing layer** — `email_messages` stores messages, not pairs |
| Diversity-aware (MMR) retrieval | ❌ | **New: MMR over candidate set** |
| Similarity-based exemplar selection | ❌ (recency only) | **New: `getSimilarExemplars` replacing `getCategoryExemplars`** |
| Empty-pool fallback | ⚠️ partial (empty → RAG fallback) | **New: corpus-size threshold → static path** |
| n8n update | n/a | Prompt assembly is in `draft-prompt` route (n8n just calls it) — **likely no n8n change** |
| Static-vs-dynamic eval | ⚠️ harness exists | **New: A/B eval run + writeup** |
| KV-cache doc | ❌ | **New: documentation** |

---

## 3. Proposed approach

**Reuse the existing `email_messages` Qdrant collection** (recommendation, pending Q1) rather than standing up `customer_sent_corpus_<id>`. The outbound replies are already embedded there with `direction` and `classification_category`; what's missing is the *pairing* of an outbound reply with the inbound it answered. Build a thin similarity-retrieval module that:

1. **Embeds the inbound** (reuse `embedText`).
2. **Retrieves candidate outbound replies** by similarity — query `email_messages` with `direction:'outbound'` filter (NOT sender-scoped — exemplars are about *this category of question*, not this counterparty). Optionally category-filtered.
3. **Pairs each retrieved outbound reply with its inbound** via `thread_id` / `inbox_message_id` join into Postgres `sent_history` (which holds `body_text` = inbound and `draft_sent` = reply). This recovers the `(inbound, reply)` example the prompt wants.
4. **MMR re-rank** the candidate set (greedy maximal-marginal-relevance, redundancy penalty λ) to avoid 5 near-duplicate exemplars.
5. **Order** the final k (default: by similarity ascending so the most-similar is last/closest to the query — recency/match are A/B-able post-launch).
6. **Empty-pool fallback:** if approved-draft corpus depth < threshold (default ~20), fall back to `getCategoryExemplars` (the current recency path).

This keeps the prompt slot (`exemplar_refs`), audit column, writeback, and privacy gate **unchanged** — only the *selection* of which exemplars fill the slot changes.

**Why not a new collection (default):** standing up `customer_sent_corpus_<id>` means a parallel embedding pipeline, a second backfill, a second bootstrap entry, and ongoing dual-write on every approved draft — for data already in `email_messages`. The pairing join into `sent_history` gives us the `(inbound, reply)` structure without duplicating vectors. Revisit if multi-tenant per-customer isolation becomes a hard requirement (it isn't on single-tenant appliances).

**Token budget (DR-18, 4096 ctx local):** current default is k=1 exemplar (~600c) + 2 RAG refs. The ticket wants 3-5 exemplars × ~500 tokens = ~2K tokens — **does not fit** the local Qwen3 4k budget alongside RAG + thread history. Resolution: keep **k=2-3 exemplars on the local path** (bounded by `RAG_RETRIEVE_EXCERPT_CHARS`), allow the full 3-5 only on the cloud path or post-bake-off Mamba/larger-ctx winner. Make k env-tunable (`EXEMPLAR_RETRIEVE_TOP_K`, `EXEMPLAR_POOL_MIN`).

---

## 4. Task breakdown (files to touch)

| # | Task | Files | Notes |
|---|---|---|---|
| T1 | Q1 decision: reuse `email_messages` vs new collection | (design) | Blocking. See §5 Q1. Plan below assumes **reuse**. |
| T2 | Similarity exemplar retrieval module | NEW `dashboard/lib/drafting/exemplar-retrieve.ts` → `getSimilarExemplars(inbound, category, k, opts)` | Embed inbound → `searchByVector({direction:'outbound', category?, limit: candidateN})` → pair via `sent_history` join → MMR → top-k. Returns same `CategoryExemplar[]` shape so the prompt slot is drop-in. Fails closed (empty → caller fallback). |
| T3 | MMR re-ranker | NEW `dashboard/lib/rag/mmr.ts` → `mmrSelect(query, candidates, k, lambda)` | Pure function: greedy MMR over candidate embeddings. Unit-testable in isolation. λ env-tunable (`EXEMPLAR_MMR_LAMBDA`, default ~0.7). |
| T4 | Corpus-depth gate + fallback | `dashboard/lib/drafting/exemplars.ts` (add `countApprovedExemplars(category)`), `dashboard/app/api/internal/draft-prompt/route.ts` | If depth < `EXEMPLAR_POOL_MIN` (default 20) → call `getCategoryExemplars` (existing recency path); else → `getSimilarExemplars`. One branch in the route's `Promise.all`. |
| T5 | Pairing query | `dashboard/lib/drafting/exemplar-retrieve.ts` (or `lib/queries-exemplars.ts`) | Given retrieved outbound `message_id`s, fetch `(body_text AS inbound, draft_sent AS reply, subject, sent_at)` from `mailbox.sent_history`. The `email_messages` outbound point's `message_id` is the join key. |
| T6 | Wire into draft-prompt route | `dashboard/app/api/internal/draft-prompt/route.ts` (the `Promise.all` ~L95, replace `getCategoryExemplars(category, 1, ...)`) | Keep writeback of `exemplar_refs` (the `message_id`s) unchanged — provenance still works. |
| T7 | Embedding-input pairing for exemplars | possibly `dashboard/lib/rag/excerpt.ts` | If similarity should be inbound-vs-inbound (best per ICL literature), we need the *inbound* embedded, not the reply. Inbound points already exist in `email_messages` (`direction:'inbound'`); consider retrieving similar *inbounds* then following to their replies. Decide in Q2. |
| T8 | Eval: static vs dynamic | `dashboard/lib/eval/bake-off.ts` / `trace-set.ts`, NEW `dashboard/scripts/eval-exemplar-ab.ts` | Run §5.8 trace set with `getCategoryExemplars` vs `getSimilarExemplars`; report edit-rate / quality delta. Gate ship on the ≥15% criterion from eval-baseline. |
| T9 | KV-cache interaction doc | NEW `docs/addendum-rag-fewshot-kvcache-v0_1-2026-05-XX.md` or section in close-out | Per-draft variable exemplars fall out of STAQPRO-347's cached prefix; persona overlay stays cached. Document the tradeoff (ticket deliverable). |
| T10 | CLAUDE.md | root `CLAUDE.md` (RAG ingestion / drafting sections) | Document the dynamic-exemplar path, the corpus-depth gate, env tunables, and that it reuses `email_messages`. |
| T11 | Env wiring | `dashboard/.env.example`, compose `mailbox-dashboard` env block | `EXEMPLAR_RETRIEVE_TOP_K`, `EXEMPLAR_POOL_MIN`, `EXEMPLAR_MMR_LAMBDA`. |

**Note on the "n8n workflow updated" deliverable:** prompt assembly is centralized in the `draft-prompt` route (D-41 anti-drift). n8n's `MailBOX-Draft` just POSTs to it and uses the returned messages. So **no n8n edit is expected** — the change is server-side. Flag this as a deviation from the ticket's literal "n8n workflow updated" wording (the route IS the SoT n8n reads).

---

## 5. Risks / unknowns + open questions for the operator

| # | Question | Recommendation | Why it matters |
|---|---|---|---|
| **Q1** | **Reuse `email_messages` (outbound points already embedded) or create `customer_sent_corpus_<id>` as the ticket specifies?** (THE biggest open question) | **Reuse `email_messages`** + pair via `sent_history` join. Zero new infra, no dual-write, ships in days. The new collection only earns its keep under multi-tenant isolation, which single-tenant appliances don't need. | Determines whether this is a "swap the selection SQL" task (days) or a "new pipeline + backfill + bootstrap + dual-write" task (weeks). Cascades through T2/T5/T7/T11. |
| Q2 | Embed/retrieve on **inbound similarity** (find similar past *questions*) or **reply similarity** (find similar past *answers*)? | Inbound-vs-inbound (ICL literature standard: retrieve by similarity to the *query*). Inbound points already exist in `email_messages` (`direction:'inbound'`); retrieve similar inbounds, follow to their replies via `thread_id`/`sent_history`. | Changes the retrieval filter and the pairing join direction. Inbound-similarity is the empirically stronger choice. |
| Q3 | Token budget — accept fewer exemplars on the 4k-ctx local path? | Yes: k=2-3 local, up to 5 cloud/post-bake-off. Env-tunable. | The ticket's "3-5 × 500 tokens = 2K" does not fit local Qwen3 4k alongside RAG + thread + persona. Be explicit or drafts truncate. |
| Q4 | Corpus-depth threshold for fallback (ticket suggests ~20)? | Start at 20, env-tunable (`EXEMPLAR_POOL_MIN`). Per-category or global? Recommend **per-category** (a customer may have 50 `inquiry` replies but 2 `escalate`). | Wrong threshold = either thin/duplicate exemplars early or never using the static safety net. |
| Q5 | MMR λ (similarity vs diversity tradeoff)? | Default 0.7 (favor relevance), tunable. A/B post-launch. | Naive top-k returns near-duplicates (ticket's explicit concern). |
| Q6 | Does this depend on the bake-off winner (STAQPRO-342)? | No for shipping (substrate-independent per MBOX-111). But token-budget headroom improves materially with a Mamba/larger-ctx winner — note the dependency for the 3-5 exemplar target. | Sequencing: MBOX-111 places this in Workstream 2 (substrate-independent), shippable before the bake-off. |
| Q7 | Privacy gate for exemplars on the cloud route? | Inherit `retrieveForDraft`'s gate: exemplars are local-email content, so CLOUD route injects them only when `RAG_CLOUD_ROUTE_ENABLED=1` (or a parallel `EXEMPLAR_CLOUD_ROUTE_ENABLED`). | Exemplars are bulk customer corpus — sending them cloud-side violates the "no bulk corpus to cloud" constraint unless explicitly opted in. |

---

## 6. Test strategy

- **MMR re-ranker** — pure-function unit tests (`dashboard/lib/rag/__tests__/mmr.test.ts`): redundancy penalty actually de-duplicates near-identical candidates; λ=1 reduces to top-k; λ=0 maximizes diversity.
- **Similarity exemplar retrieval** — mock `searchByVector` + `sent_history` join (pattern from `dashboard/lib/rag/__tests__/retrieve.test.ts`, which mocks Qdrant fetch). Assert: empty corpus → empty (fallback triggers); below-threshold → static path; pairing recovers `(inbound, reply)`; fails closed on Qdrant/embed error.
- **Corpus-depth gate** — unit test the branch in `draft-prompt` route: depth < min → `getCategoryExemplars`; depth ≥ min → `getSimilarExemplars`.
- **Static-vs-dynamic A/B** — the deliverable eval (T8). Run §5.8 trace set both ways; the ship gate is the eval-baseline ≥15%-relative-edit-rate-reduction criterion (or a quality-judge delta via `lib/drafting/judge.ts`).
- **Token-budget regression** — assert assembled prompt stays under the local 4k ctx with k=3 exemplars + 2 RAG + thread history (a `prompt.ts` assembly test with worst-case fixtures).
- **Vitest** in CI (gate is real per MBOX-337). Eval-only short-circuit `RAG_DISABLED=1` exists (STAQPRO-198) for harness isolation.

---

## 7. Blockers / dependencies

- **Blocked by (per ticket):** STAQPRO-341 (static few-shot substrate) — **satisfied** (`exemplars.ts` shipped). STAQPRO-340 (eval harness) — **substantially satisfied** (`lib/eval/trace-set.ts`, `bake-off.ts`, `eval-baseline.ts` exist); confirm the trace set is populated.
- **Soft dependency:** STAQPRO-347 (KV-cache) — not a blocker; this ticket *documents* the interaction (T9). STAQPRO-342 (bake-off) — not a blocker but improves token headroom for the 3-5 target (Q6).
- **Hard prerequisite for quality:** the `email_messages` outbound corpus must be populated. On a fresh appliance with <20 approved drafts, this runs in pure-fallback (static) mode until the corpus deepens — by design (monotonic improvement). For M1, run `rag-backfill.ts` first if the outbound corpus is thin (memory-pre-flight guarded; do NOT run during a soak window per the DR-25 lesson).
- **Decision gate:** Q1 (collection reuse vs new) must be resolved before T2 starts — it's the difference between a days-scale and weeks-scale effort.
- **Doctrine:** "minimize cloud" — exemplar injection on the cloud path must stay gated (Q7); default-local keeps the cloud-call fraction flat.
