// dashboard/lib/rag/chat-retrieve.ts
//
// MBOX-283 — query-scoped retrieval for the local-model chat surface
// (epic MBOX-282). The customer asks their own appliance a question; we
// embed that question and retrieve the most relevant prior messages from
// the existing `email_messages` Qdrant collection (STAQPRO-188, 768d /
// Cosine) to ground the chat answer in their own correspondence.
//
// === How this differs from the draft path (retrieve.ts) ===
//
// The draft path (retrieveForDraft, STAQPRO-191) is COUNTERPARTY-scoped: it
// hard-filters `payload.sender == inbound.from_addr` because a draft is a
// reply to one person and only that person's history is relevant. There is
// no counterparty here — the chat query is free-form ("what did the supplier
// say about the Q3 delay?"), so retrieval is QUERY-scoped: embed the query,
// top-k over the WHOLE collection, rank by cosine similarity. No sender
// filter, no outbound voice-priming arm, no self-filter (there is no "self"
// inbound message in a chat turn).
//
// === Relevance floor (CHAT_RETRIEVE_SCORE_FLOOR) ===
//
// Because the query is unconstrained, low-similarity hits are common and
// actively harmful — they let the model claim grounding it doesn't have.
// We apply a relevance floor (cf. RAG_MIN_SCORE in retrieve.ts H5): drop
// every hit below the floor. If nothing clears the floor we return empty
// refs with reason 'below_floor', distinct from 'no_hits' (Qdrant returned
// nothing at all), so MBOX-287 can fall back to plain chat ("no document
// claims") and the difference is visible in telemetry / persisted
// rag_retrieval_reason.
//
// === Failure mode ===
//
// Mirrors retrieve.ts: every path returns a success-shaped result
// ({ refs: [], reason }) rather than throwing. RAG is augmentation, not a
// gate (per the project Constraints + the CLAUDE.md "RAG retrieval" section).
// On embed/Qdrant outage the chat still answers from the local model alone.
//
// === Privacy ===
//
// Chat is strictly local (DR-53, MBOX-282) — there is no cloud route, so the
// cloud privacy gate (RAG_CLOUD_ROUTE_ENABLED) does not apply here. Retrieval
// always runs. Reusing the same on-device nomic-embed-text:v1.5 + local
// Qdrant keeps all corpus content on the appliance.
//
// === Per-account isolation (MBOX-400, MBOX-162 V7) ===
//
// Query-scoped does NOT mean corpus-wide across inboxes. On a multi-account
// appliance, "Ask the KB" must only see the history of the inbox the operator
// is asking about — otherwise account #2's mail leaks into account #1's chat
// answer. The caller passes the conversation's account_id (resolved from
// chat_conversations.account_id, migration 033) and we hard-filter
// payload.account_id via searchByVector's accountFilter (the same primitive the
// draft path uses, STAQPRO-191 / MBOX-352). accountId is optional: when omitted
// (the standalone eval/test caller), no account filter is applied and retrieval
// is corpus-wide — back-compat for single-account / harness callers. The live
// chat path (runChatTurn) always resolves and passes it.

import { embedText } from './embed';
import { searchByVector } from './qdrant';

export interface ChatRetrievalRef {
  // Qdrant point UUID (RFC 4122 v4, deterministic from message_id). MBOX-287
  // persists these into chat_messages.rag_context_refs (MBOX-285) and renders
  // them as sources.
  point_id: string;
  // Gmail message_id of the source message — lets the UI reverse the hash and
  // link back to the underlying mail (cf. getPointsByIds in qdrant.ts).
  message_id: string;
  excerpt: string;
  score: number;
}

export type ChatRetrievalReason =
  | 'ok'
  // Embed model unreachable / wrong shape — chat falls back to plain answer.
  | 'embed_unavailable'
  // Qdrant unreachable or returned an unexpected shape.
  | 'qdrant_unavailable'
  // Qdrant searched and returned zero points (corpus empty / no match at all).
  | 'no_hits'
  // MBOX-283 — Qdrant returned candidate hits but every one scored below
  // CHAT_RETRIEVE_SCORE_FLOOR. Distinct from 'no_hits' so the UI / telemetry
  // can tell "nothing indexed" apart from "nothing relevant enough to cite."
  | 'below_floor'
  // Query string was empty/whitespace after trim — nothing to embed.
  | 'empty_query';

export interface ChatRetrievalResult {
  refs: ChatRetrievalRef[];
  reason: ChatRetrievalReason;
}

// Top-k for chat retrieval. Separate knob from the draft path's
// RAG_RETRIEVE_TOP_K so chat can pull a wider set of sources without
// disturbing the draft-prompt token budget (DR-18, 4096 ctx). Default 4.
function topK(): number {
  const parsed = Number(process.env.CHAT_RETRIEVE_TOP_K ?? 4);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

// Relevance floor for chat (cf. RAG_MIN_SCORE in retrieve.ts H5). Cosine in
// [0,1]; below ~0.65 hits are usually topically unrelated and should not be
// presented as sources. NaN/typo guard returns the conservative default so a
// malformed env value can't silently open the floor wide.
function scoreFloor(): number {
  const parsed = Number.parseFloat(process.env.CHAT_RETRIEVE_SCORE_FLOOR ?? '0.65');
  return Number.isFinite(parsed) ? parsed : 0.65;
}

// Per-snippet excerpt cap — reuse the draft path's RAG_RETRIEVE_EXCERPT_CHARS
// convention (default 600 ≈ 150 tokens) per the issue's acceptance criterion.
function excerptCharCap(): number {
  const parsed = Number(process.env.RAG_RETRIEVE_EXCERPT_CHARS ?? 600);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
}

export async function retrieveForChat(
  query: string,
  accountId?: number,
): Promise<ChatRetrievalResult> {
  const trimmed = (query ?? '').trim();
  if (!trimmed) {
    return { refs: [], reason: 'empty_query' };
  }

  const vector = await embedText(trimmed);
  if (!vector) {
    return { refs: [], reason: 'embed_unavailable' };
  }

  // Query-scoped: no sender/recipient/persona/self/thread filters — we want the
  // most relevant prior messages across the whole corpus. The one exception is
  // the per-account hard filter (MBOX-400): when accountId is supplied, recall
  // is scoped to that inbox so a multi-account box never bleeds one inbox's
  // history into another's chat answer. Omitted → corpus-wide (harness/eval).
  const search = await searchByVector(vector, {
    limit: topK(),
    ...(accountId !== undefined ? { accountFilter: accountId } : {}),
  });
  if (!search.ok) {
    return { refs: [], reason: 'qdrant_unavailable' };
  }
  if (search.hits.length === 0) {
    return { refs: [], reason: 'no_hits' };
  }

  // Relevance floor (inclusive >=, matching retrieve.ts H5).
  const floor = scoreFloor();
  const survivors = search.hits.filter((h) => h.score >= floor);
  if (survivors.length === 0) {
    return { refs: [], reason: 'below_floor' };
  }

  const cap = excerptCharCap();
  const refs: ChatRetrievalRef[] = survivors.map((h) => ({
    point_id: h.id,
    message_id: h.payload.message_id,
    excerpt: (h.payload.body_excerpt ?? '').slice(0, cap),
    score: h.score,
  }));

  return { refs, reason: 'ok' };
}
