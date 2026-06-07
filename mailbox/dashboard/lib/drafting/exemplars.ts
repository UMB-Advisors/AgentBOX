// dashboard/lib/drafting/exemplars.ts
//
// STAQPRO-234 (KB Phase 1) — auto-mined few-shot exemplars from sent_history.
//
// The operator already wrote the answers to the categories the local model
// keeps fumbling. The drafts they approved/edited landed in mailbox.sent_history
// via the migration 010/013/014/020 archival trigger; this module pulls the
// most-recent k examples per category to inject as concrete examples in the
// drafting prompt. Highest-leverage local-model boost without any new corpus,
// OAuth, or privacy surface.
//
// Distinct from `persona.category_exemplars`: those are hand-curated by the
// operator (STAQPRO-149); these are auto-mined from real send history. Per
// Neo Architect: different semantics → different surface. They live in their
// own prompt slot (`exemplar_refs`) in lib/drafting/prompt.ts and their own
// audit column (`drafts.exemplar_refs`, migration 020).
//
// Storage choice (per the issue's "pick the cleaner option" prompt):
// - Sibling jsonb column `drafts.exemplar_refs` (NOT a discriminator inside
//   `rag_context_refs`). Reasoning is in migration 020's WHY block —
//   STAQPRO-191/192's eval surface depends on rag_context_refs being a
//   pure UUID array of Qdrant points; mixing in postgres-row references
//   would force a discriminator and break the existing replay path.

import { sql } from 'kysely';
import type { Category } from '@/lib/classification/prompt';
import { getKysely } from '@/lib/db';

export interface CategoryExemplar {
  // The mailbox.sent_history.message_id used as the audit pointer (NULL for
  // pre-message_id rows; we exclude those in the query). Used to populate
  // drafts.exemplar_refs.
  message_id: string;
  // The body the operator actually sent — truncated to RAG_RETRIEVE_EXCERPT_CHARS.
  // This is what gets injected into the prompt as a "past reply" example.
  snippet: string;
  // ISO-8601. Used to label the prompt section (the LLM does better when it
  // can ground "recent" vs "old").
  sent_at: string;
  // Optional subject (helpful context for the LLM but not strictly required).
  subject?: string;
}

// Per-snippet character cap — reuses RAG_RETRIEVE_EXCERPT_CHARS to stay inside
// the 4096-token Qwen3 context budget per DR-18. Same default (600 chars ≈
// 150 tokens) as RAG snippets so 1 exemplar + 2 RAG refs fits in the existing
// ~450-token augmentation slice.
function excerptCharCap(): number {
  return Number(process.env.RAG_RETRIEVE_EXCERPT_CHARS ?? 600);
}

/**
 * Get up to k recent exemplars from mailbox.sent_history for a given category.
 *
 * Returns an empty array when no rows match — the caller (draft-prompt route)
 * falls back to the today's 3 RAG refs path. Graceful degrade.
 *
 * The `persona_key` parameter is accepted for forward-compat with multi-persona
 * support; today every appliance is single-persona ('default') and there's no
 * `persona_key` column on `sent_history`, so it's a no-op filter for now.
 * When multi-persona ships, add a join + filter here.
 *
 * @param category   The classification category to filter on.
 * @param k          Maximum number of exemplars to return.
 * @param persona_key Reserved for multi-persona; ignored today.
 * @param accountId  MBOX-352 (MBOX-162 V2) — when set, restricts the mined
 *                   exemplars to one account's send history so each mailbox
 *                   primes the drafter with its own past replies. Omitted →
 *                   corpus-wide (pre-V2 behavior); the draft-prompt route
 *                   passes the in-flight draft's account.
 */
export async function getCategoryExemplars(
  category: Category,
  k: number,
  // biome-ignore lint/correctness/noUnusedFunctionParameters: persona_key reserved for multi-persona; see comment above
  persona_key?: string,
  accountId?: number,
): Promise<ReadonlyArray<CategoryExemplar>> {
  if (k <= 0) return [];
  const cap = excerptCharCap();
  // null sentinel → the `IS NULL OR` guard below is a no-op (corpus-wide).
  const acct = accountId ?? null;

  try {
    const db = getKysely();
    // Use a SQL template here rather than the kysely builder because we want
    // LEFT(body_text, $cap) computed server-side rather than pulling full
    // bodies and trimming in TS. Sub-ms per query against the
    // sent_history_category_idx + sent_history_sent_at_idx indexes.
    const rows = await sql<{
      message_id: string;
      snippet: string;
      sent_at: string;
      subject: string | null;
    }>`
      SELECT
        message_id,
        LEFT(COALESCE(draft_sent, body_text, ''), ${cap}) AS snippet,
        sent_at::text AS sent_at,
        subject
      FROM mailbox.sent_history
      WHERE classification_category = ${category}
        AND message_id IS NOT NULL
        AND COALESCE(draft_sent, body_text) IS NOT NULL
        AND LENGTH(TRIM(COALESCE(draft_sent, body_text, ''))) > 0
        AND (${acct}::int IS NULL OR account_id = ${acct})
      ORDER BY sent_at DESC
      LIMIT ${k}
    `.execute(db);

    return rows.rows.map((r) => ({
      message_id: r.message_id,
      snippet: r.snippet,
      sent_at: r.sent_at,
      subject: r.subject ?? undefined,
    }));
  } catch (error) {
    // Fail-closed semantics: empty array means "no exemplars to inject" and
    // the caller falls back to RAG-only. Never throw — drafting must proceed
    // even if sent_history is unreadable.
    console.error('getCategoryExemplars failed:', error);
    return [];
  }
}
