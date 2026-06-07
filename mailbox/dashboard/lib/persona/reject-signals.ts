// MBOX-375 — pure aggregation of reject feedback → a reject_signals block.
//
// Reject-side analogue of the (still-backlog) MBOX-187 edit_signals work; same
// parent learning loop (MBOX-186). MBOX-198 #1 shipped the *capture* side
// (mailbox.draft_feedback + the 6-code taxonomy + the reject route writing one
// row per rejection). This consumes those rows.
//
// Pure, DB-free (mirrors lib/persona/extract.ts) so it's vitest-testable with no
// Postgres. The query layer (lib/queries-persona.ts:listRejectFeedbackForSignals)
// joins draft_feedback → drafts → inbox_messages and normalizes the sender; this
// function only buckets the flat rows it's handed.
//
// EVERY output is an operator-confirm SUGGESTION or an eval/re-label INPUT — this
// module never mutates persona or the classifier (MBOX-375 "Out of scope").

import type { RejectReasonCode } from '@/lib/types';
import { REJECT_REASON_CODES } from '@/lib/types';
import type {
  ClassifierRelabelCandidate,
  RagQualityStat,
  RejectRateStat,
  RejectSignals,
} from './types';

export interface RejectFeedbackInput {
  draft_id: number;
  reason_code: RejectReasonCode;
  classification_category: string | null;
  sender: string | null; // already normalized by the query layer
  inbound_subject: string | null;
  inbound_body: string | null;
  rejected_at: string;
}

// Keep the per-sender map bounded — top senders by rejection volume only.
const TOP_SENDERS = 10;
const RELABEL_EXCERPT_CHARS = 500;

// Suggestion fires only with enough signal to be worth the operator's attention.
const SUGGESTION_MIN_REJECTIONS = 3;
const SUGGESTION_MIN_SHARE = 0.4;

export function aggregateRejectSignals(rows: RejectFeedbackInput[]): RejectSignals {
  const byReason = emptyReasonCounts();
  const total = rows.length;

  // Per-category accumulators (wrong_tone + rag-quality share one pass).
  const catRejections = new Map<string, number>();
  const catWrongTone = new Map<string, number>();
  const catInaccurate = new Map<string, number>();
  const catMissingContext = new Map<string, number>();

  // Per-sender wrong_tone accumulators.
  const senderRejections = new Map<string, number>();
  const senderWrongTone = new Map<string, number>();

  let totalWrongTone = 0;
  let totalInaccurate = 0;
  let totalMissingContext = 0;

  const relabelCandidates: ClassifierRelabelCandidate[] = [];

  for (const row of rows) {
    byReason[row.reason_code] += 1;

    const cat = row.classification_category;
    if (cat) {
      catRejections.set(cat, (catRejections.get(cat) ?? 0) + 1);
    }
    const sender = row.sender;
    if (sender) {
      senderRejections.set(sender, (senderRejections.get(sender) ?? 0) + 1);
    }

    switch (row.reason_code) {
      case 'wrong_tone': {
        totalWrongTone += 1;
        if (cat) catWrongTone.set(cat, (catWrongTone.get(cat) ?? 0) + 1);
        if (sender) senderWrongTone.set(sender, (senderWrongTone.get(sender) ?? 0) + 1);
        break;
      }
      case 'factually_inaccurate': {
        totalInaccurate += 1;
        if (cat) catInaccurate.set(cat, (catInaccurate.get(cat) ?? 0) + 1);
        break;
      }
      case 'missing_context': {
        totalMissingContext += 1;
        if (cat) catMissingContext.set(cat, (catMissingContext.get(cat) ?? 0) + 1);
        break;
      }
      case 'should_reply_myself':
      case 'dont_reply': {
        relabelCandidates.push({
          draft_id: row.draft_id,
          sender,
          current_category: cat,
          reason_code: row.reason_code,
          suggested_category:
            row.reason_code === 'should_reply_myself' ? 'escalate' : 'spam_marketing',
          inbound_subject: row.inbound_subject,
          inbound_body_excerpt: (row.inbound_body ?? '').slice(0, RELABEL_EXCERPT_CHARS),
          rejected_at: row.rejected_at,
        });
        break;
      }
      default:
        break;
    }
  }

  const wrongToneByCategory = buildRateStats(catRejections, catWrongTone);
  const wrongToneBySender = topRateStats(senderRejections, senderWrongTone, TOP_SENDERS);
  const ragByCategory = buildRagStats(catRejections, catInaccurate, catMissingContext);

  const wrongToneOverall = ratio(totalWrongTone, total);
  const ragOverall = ratio(totalInaccurate + totalMissingContext, total);

  return {
    total_rejections: total,
    by_reason: byReason,
    wrong_tone: {
      overall_share: wrongToneOverall,
      per_category: wrongToneByCategory,
      per_sender: wrongToneBySender,
      suggestion: toneSuggestion(total, totalWrongTone, wrongToneByCategory),
    },
    rag_quality: {
      overall_share: ragOverall,
      per_category: ragByCategory,
      suggestion: ragSuggestion(total, totalInaccurate + totalMissingContext),
    },
    classifier_relabel_candidates: relabelCandidates,
    computed_at: new Date().toISOString(),
  };
}

// ---------- helpers ----------

function emptyReasonCounts(): Record<RejectReasonCode, number> {
  const out = {} as Record<RejectReasonCode, number>;
  for (const code of REJECT_REASON_CODES) out[code] = 0;
  return out;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100) / 100;
}

function buildRateStats(
  rejections: Map<string, number>,
  wrongTone: Map<string, number>,
): Record<string, RejectRateStat> {
  const out: Record<string, RejectRateStat> = {};
  for (const [key, total] of rejections.entries()) {
    const wt = wrongTone.get(key) ?? 0;
    out[key] = { rejections: total, wrong_tone: wt, share: ratio(wt, total) };
  }
  return out;
}

// Same as buildRateStats but keeps only the top-N keys by rejection volume —
// bounds the per-sender map so the JSONB blob stays small over time.
function topRateStats(
  rejections: Map<string, number>,
  wrongTone: Map<string, number>,
  n: number,
): Record<string, RejectRateStat> {
  const top = [...rejections.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
  const out: Record<string, RejectRateStat> = {};
  for (const [key, total] of top) {
    const wt = wrongTone.get(key) ?? 0;
    out[key] = { rejections: total, wrong_tone: wt, share: ratio(wt, total) };
  }
  return out;
}

function buildRagStats(
  rejections: Map<string, number>,
  inaccurate: Map<string, number>,
  missingContext: Map<string, number>,
): Record<string, RagQualityStat> {
  const out: Record<string, RagQualityStat> = {};
  for (const [key, total] of rejections.entries()) {
    const fi = inaccurate.get(key) ?? 0;
    const mc = missingContext.get(key) ?? 0;
    if (fi === 0 && mc === 0) continue; // only surface categories with a RAG signal
    out[key] = {
      rejections: total,
      factually_inaccurate: fi,
      missing_context: mc,
      share: ratio(fi + mc, total),
    };
  }
  return out;
}

// Read-only nudge. Names the single worst category if one stands out, else falls
// back to the overall rate. Returns null below the noise floor so the UI stays
// quiet until the signal is real.
function toneSuggestion(
  total: number,
  totalWrongTone: number,
  perCategory: Record<string, RejectRateStat>,
): string | null {
  if (total < SUGGESTION_MIN_REJECTIONS) return null;
  const overall = ratio(totalWrongTone, total);
  if (overall < SUGGESTION_MIN_SHARE) return null;

  let worst: { cat: string; stat: RejectRateStat } | null = null;
  for (const [cat, stat] of Object.entries(perCategory)) {
    if (stat.rejections < SUGGESTION_MIN_REJECTIONS) continue;
    if (stat.share < SUGGESTION_MIN_SHARE) continue;
    if (!worst || stat.share > worst.stat.share) worst = { cat, stat };
  }

  const pct = Math.round(overall * 100);
  if (worst) {
    const catPct = Math.round(worst.stat.share * 100);
    return `Tone is the top rejection reason (${pct}% of ${total} rejections), concentrated in "${worst.cat}" (${catPct}%). Consider a tone override for that category — apply it yourself; nothing is changed automatically.`;
  }
  return `Tone is the top rejection reason (${pct}% of ${total} rejections). Consider setting a tone override — apply it yourself; nothing is changed automatically.`;
}

function ragSuggestion(total: number, ragRejections: number): string | null {
  if (total < SUGGESTION_MIN_REJECTIONS) return null;
  const share = ratio(ragRejections, total);
  if (share < SUGGESTION_MIN_SHARE) return null;
  const pct = Math.round(share * 100);
  return `${pct}% of rejections cite a factual/context gap — a retrieval-quality signal. Consider raising RAG_RETRIEVE_TOP_K or tightening the sender filter, then re-run scripts/rag-eval-harness.ts.`;
}
