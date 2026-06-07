// STAQPRO-153 — canonical shape for mailbox.persona.statistical_markers and
// mailbox.persona.category_exemplars. The DB column is JSONB so the shape
// here is the application contract; rows written before this contract was
// defined (e.g. manual edits via STAQPRO-149) may have arbitrary keys and
// MUST round-trip cleanly via the openSchema in lib/schemas/persona.ts.

import type { Category } from '@/lib/classification/prompt';
import type { RejectReasonCode } from '@/lib/types';

export interface PerCategoryMarkers {
  sample_size: number;
  avg_sentence_words: number;
  formality_score: number; // 0..1 — see lib/persona/extract.ts
}

export interface StatisticalMarkers {
  source_email_count: number;
  avg_sentence_words: number;
  median_sentence_words: number;
  formality_score: number;
  sign_off_top: string[];
  greeting_top: string[];
  common_phrases: string[];
  emoji_count: number;
  per_category: Partial<Record<Category, PerCategoryMarkers>>;
  extracted_at: string; // ISO

  // STAQPRO-195 operator-set override layer. These are NOT produced by
  // extractPersona() — they're set via the persona settings UI and trump the
  // extracted/derived defaults in lib/drafting/persona.ts:resolvePersonaContext.
  tone?: string;
  signoff?: string;
  operator_first_name?: string;
  operator_brand?: string;

  // MBOX-375 reject-feedback aggregation. Sibling to the (still-backlog)
  // MBOX-187 edit_signals block; produced by lib/persona/reject-signals.ts and
  // merged here by the persona-refresh route. Read-only operator-confirm
  // suggestions + classifier eval inputs — NEVER auto-applied to persona or the
  // classifier (per MBOX-375 "Out of scope"). Surfaced in the settings UI under
  // "Patterns from your rejections".
  reject_signals?: RejectSignals;
}

// ---------- MBOX-375 reject-feedback signal shapes ----------

// wrong_tone concentration within a category/sender bucket. NOTE: `share` is
// the fraction of that bucket's *rejections* tagged wrong_tone — denominator is
// rejections, not total drafts (the aggregator only sees draft_feedback rows).
// High concentration → strong candidate for a tone override in that bucket.
export interface RejectRateStat {
  rejections: number;
  wrong_tone: number;
  share: number; // 0..1, rounded to 2dp
}

// factually_inaccurate + missing_context concentration → RAG-quality signal.
// Ties to RAG_RETRIEVE_TOP_K / sender-filter tuning (complements rag-eval-harness).
export interface RagQualityStat {
  rejections: number;
  factually_inaccurate: number;
  missing_context: number;
  share: number; // (factually_inaccurate + missing_context) / rejections, 0..1
}

// One exportable classifier re-label / eval candidate. should_reply_myself rows
// lean `escalate`; dont_reply rows lean `spam_marketing`. The inbound excerpt is
// the text a re-label/eval pass would re-classify.
export interface ClassifierRelabelCandidate {
  draft_id: number;
  sender: string | null;
  current_category: string | null;
  reason_code: 'should_reply_myself' | 'dont_reply';
  suggested_category: 'escalate' | 'spam_marketing';
  inbound_subject: string | null;
  inbound_body_excerpt: string;
  rejected_at: string;
}

export interface RejectSignals {
  total_rejections: number;
  by_reason: Record<RejectReasonCode, number>;
  wrong_tone: {
    overall_share: number; // total wrong_tone / total_rejections
    per_category: Record<string, RejectRateStat>;
    per_sender: Record<string, RejectRateStat>;
    suggestion: string | null;
  };
  rag_quality: {
    overall_share: number;
    per_category: Record<string, RagQualityStat>;
    suggestion: string | null;
  };
  classifier_relabel_candidates: ClassifierRelabelCandidate[];
  computed_at: string; // ISO
}

export interface CategoryExemplar {
  inbound_subject: string | null;
  inbound_body_excerpt: string;
  sent_body: string;
  sent_at: string;
}

export type CategoryExemplars = Partial<Record<Category, CategoryExemplar[]>>;
