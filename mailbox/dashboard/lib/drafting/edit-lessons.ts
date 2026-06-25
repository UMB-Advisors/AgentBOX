// dashboard/lib/drafting/edit-lessons.ts
//
// Diff-based learning loop — contrastive "edit lessons" mined from sent_history.
//
// Distinct from `exemplars.ts` (STAQPRO-234), which injects the operator's
// final SENT body as a positive few-shot. This module mines the *delta*: rows
// where the operator EDITED the model's draft before sending — i.e.
// `draft_original IS NOT NULL AND draft_original <> draft_sent`. Each becomes a
// contrastive pair ("you drafted X; the operator changed it to Y") so the local
// model learns the correction pattern, not just the destination.
//
// The raw material already exists: `mailbox.sent_history.draft_original` is the
// LLM draft snapshotted on first edit (migration 012), and `draft_sent` is what
// the operator actually sent. Nothing consumed the delta before this.
//
// Same constraints as exemplars: no new LLM call, no new corpus, no OAuth/
// privacy surface, fail-closed (never throws — drafting must proceed), and a
// tight per-snippet char cap to stay inside the Qwen3-4B 4k-token budget.

import { sql } from 'kysely';
import type { Category } from '@/lib/classification/prompt';
import { getKysely } from '@/lib/db';

export interface EditLesson {
  // sent_history.message_id — audit pointer (NULL rows excluded).
  message_id: string;
  // The model's original draft (draft_original), truncated. The "before".
  original: string;
  // What the operator actually sent (draft_sent), truncated. The "after".
  final: string;
  // ISO-8601 — labels the section so the LLM can ground "recent".
  sent_at: string;
  subject?: string;
}

// Per-snippet cap. Smaller than exemplars' 600c because each lesson carries TWO
// snippets (before + after); 400c × 2 ≈ 200 tokens per lesson keeps one lesson
// + one exemplar + 2 RAG refs inside the existing augmentation budget.
function excerptCharCap(): number {
  return Number(process.env.EDIT_LESSON_EXCERPT_CHARS ?? 400);
}

/** Feature flag — default ON. Set EDIT_LESSONS_ENABLED=0 to disable the loop
 *  (e.g. if local-model evals regress). */
export function editLessonsEnabled(): boolean {
  return process.env.EDIT_LESSONS_ENABLED !== '0';
}

/**
 * Get up to k recent edit lessons for a category — operator-edited drafts where
 * the sent body diverged from the model's original.
 *
 * Returns [] when disabled, when k<=0, when nothing matches, or on any error
 * (fail-closed: the caller falls back to exemplars/RAG and drafting proceeds).
 *
 * @param category    Classification category to filter on.
 * @param k           Max lessons to return (caller passes 1 to protect ctx).
 * @param persona_key Reserved for multi-persona; ignored today (no column).
 * @param accountId   When set, restricts to one mailbox's edit history so each
 *                    account learns from its own corrections; omit → corpus-wide.
 */
export async function getEditLessons(
  category: Category,
  k: number,
  // biome-ignore lint/correctness/noUnusedFunctionParameters: persona_key reserved for multi-persona, matching exemplars.ts
  persona_key?: string,
  accountId?: number,
): Promise<ReadonlyArray<EditLesson>> {
  if (!editLessonsEnabled() || k <= 0) return [];
  const cap = excerptCharCap();
  const acct = accountId ?? null;

  try {
    const db = getKysely();
    const rows = await sql<{
      message_id: string;
      original: string;
      final: string;
      sent_at: string;
      subject: string | null;
    }>`
      SELECT
        message_id,
        LEFT(draft_original, ${cap}) AS original,
        LEFT(draft_sent, ${cap}) AS final,
        sent_at::text AS sent_at,
        subject
      FROM mailbox.sent_history
      WHERE classification_category = ${category}
        AND message_id IS NOT NULL
        AND draft_original IS NOT NULL
        AND draft_sent IS NOT NULL
        AND LENGTH(TRIM(draft_original)) > 0
        AND LENGTH(TRIM(draft_sent)) > 0
        AND draft_original <> draft_sent
        AND (${acct}::int IS NULL OR account_id = ${acct})
      ORDER BY sent_at DESC
      LIMIT ${k}
    `.execute(db);

    return rows.rows.map((r) => ({
      message_id: r.message_id,
      original: r.original,
      final: r.final,
      sent_at: r.sent_at,
      subject: r.subject ?? undefined,
    }));
  } catch (error) {
    // Fail-closed: empty means "no lessons to inject"; drafting must proceed
    // even if sent_history is unreadable.
    console.error('getEditLessons failed:', error);
    return [];
  }
}
