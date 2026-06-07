import { describe, expect, it } from 'vitest';
import { aggregateRejectSignals, type RejectFeedbackInput } from '@/lib/persona/reject-signals';

// Pure-eval: no DB. Mirrors persona-extract.test.ts style.

function row(over: Partial<RejectFeedbackInput>): RejectFeedbackInput {
  return {
    draft_id: 1,
    reason_code: 'wrong_tone',
    classification_category: 'inquiry',
    sender: 'a@example.com',
    inbound_subject: null,
    inbound_body: null,
    rejected_at: '2026-05-30T10:00:00Z',
    ...over,
  };
}

describe('aggregateRejectSignals', () => {
  it('returns an empty-but-shaped result for empty input', () => {
    const r = aggregateRejectSignals([]);
    expect(r.total_rejections).toBe(0);
    expect(r.by_reason.wrong_tone).toBe(0);
    expect(r.by_reason.dont_reply).toBe(0);
    expect(r.wrong_tone.overall_share).toBe(0);
    expect(r.wrong_tone.per_category).toEqual({});
    expect(r.wrong_tone.per_sender).toEqual({});
    expect(r.rag_quality.per_category).toEqual({});
    expect(r.classifier_relabel_candidates).toEqual([]);
    expect(r.wrong_tone.suggestion).toBeNull();
    expect(r.rag_quality.suggestion).toBeNull();
  });

  it('single-code: all wrong_tone in one category → 100% concentration', () => {
    const rows = [row({ draft_id: 1 }), row({ draft_id: 2 }), row({ draft_id: 3 })];
    const r = aggregateRejectSignals(rows);
    expect(r.total_rejections).toBe(3);
    expect(r.by_reason.wrong_tone).toBe(3);
    expect(r.wrong_tone.overall_share).toBe(1);
    expect(r.wrong_tone.per_category.inquiry).toEqual({
      rejections: 3,
      wrong_tone: 3,
      share: 1,
    });
    // 3 rejections at 100% share clears the suggestion floor.
    expect(r.wrong_tone.suggestion).toMatch(/inquiry/);
  });

  it('mixed categories: per-category shares are independent', () => {
    const rows = [
      // inquiry: 1 wrong_tone of 2 → 0.5
      row({ draft_id: 1, classification_category: 'inquiry', reason_code: 'wrong_tone' }),
      row({ draft_id: 2, classification_category: 'inquiry', reason_code: 'missing_context' }),
      // reorder: 2 wrong_tone of 2 → 1.0
      row({ draft_id: 3, classification_category: 'reorder', reason_code: 'wrong_tone' }),
      row({ draft_id: 4, classification_category: 'reorder', reason_code: 'wrong_tone' }),
    ];
    const r = aggregateRejectSignals(rows);
    expect(r.total_rejections).toBe(4);
    expect(r.wrong_tone.per_category.inquiry.share).toBe(0.5);
    expect(r.wrong_tone.per_category.reorder.share).toBe(1);
    expect(r.wrong_tone.overall_share).toBe(0.75); // 3/4
    // missing_context surfaces in rag_quality for inquiry only.
    expect(r.rag_quality.per_category.inquiry).toMatchObject({
      missing_context: 1,
      factually_inaccurate: 0,
    });
    expect(r.rag_quality.per_category.reorder).toBeUndefined();
  });

  it('rag_quality aggregates factually_inaccurate + missing_context', () => {
    const rows = [
      row({ draft_id: 1, classification_category: 'inquiry', reason_code: 'factually_inaccurate' }),
      row({ draft_id: 2, classification_category: 'inquiry', reason_code: 'missing_context' }),
      row({ draft_id: 3, classification_category: 'inquiry', reason_code: 'wrong_tone' }),
    ];
    const r = aggregateRejectSignals(rows);
    expect(r.rag_quality.overall_share).toBe(0.67); // 2/3 rounded
    expect(r.rag_quality.per_category.inquiry).toEqual({
      rejections: 3,
      factually_inaccurate: 1,
      missing_context: 1,
      share: 0.67,
    });
    expect(r.rag_quality.suggestion).toMatch(/RAG_RETRIEVE_TOP_K/);
  });

  it('per-sender wrong_tone concentration tracks separately from category', () => {
    const rows = [
      row({ draft_id: 1, sender: 'vip@acme.com', reason_code: 'wrong_tone' }),
      row({ draft_id: 2, sender: 'vip@acme.com', reason_code: 'wrong_tone' }),
      row({ draft_id: 3, sender: 'other@x.com', reason_code: 'missing_context' }),
    ];
    const r = aggregateRejectSignals(rows);
    expect(r.wrong_tone.per_sender['vip@acme.com']).toEqual({
      rejections: 2,
      wrong_tone: 2,
      share: 1,
    });
    // other@x.com had a rejection but zero wrong_tone → share 0, still present.
    expect(r.wrong_tone.per_sender['other@x.com']).toEqual({
      rejections: 1,
      wrong_tone: 0,
      share: 0,
    });
  });

  it('classifier re-label candidates map reason → suggested category with inbound excerpt', () => {
    const rows = [
      row({
        draft_id: 10,
        reason_code: 'should_reply_myself',
        classification_category: 'inquiry',
        inbound_subject: 'Personal ask',
        inbound_body: 'x'.repeat(800),
      }),
      row({
        draft_id: 11,
        reason_code: 'dont_reply',
        classification_category: 'inquiry',
        inbound_body: 'Buy now!',
      }),
      row({ draft_id: 12, reason_code: 'wrong_tone' }), // not a candidate
    ];
    const r = aggregateRejectSignals(rows);
    expect(r.classifier_relabel_candidates).toHaveLength(2);

    const reply = r.classifier_relabel_candidates.find((c) => c.draft_id === 10);
    expect(reply?.suggested_category).toBe('escalate');
    expect(reply?.reason_code).toBe('should_reply_myself');
    expect(reply?.inbound_body_excerpt).toHaveLength(500); // capped

    const drop = r.classifier_relabel_candidates.find((c) => c.draft_id === 11);
    expect(drop?.suggested_category).toBe('spam_marketing');
    expect(drop?.inbound_body_excerpt).toBe('Buy now!');
  });

  it('suggestion stays null below the noise floor (too few rejections)', () => {
    const rows = [row({ draft_id: 1 }), row({ draft_id: 2 })]; // 2 < min 3
    const r = aggregateRejectSignals(rows);
    expect(r.wrong_tone.suggestion).toBeNull();
  });

  it('rows with null category/sender do not crash and are skipped from buckets', () => {
    const rows = [
      row({ draft_id: 1, classification_category: null, sender: null, reason_code: 'wrong_tone' }),
      row({
        draft_id: 2,
        classification_category: 'inquiry',
        sender: 'a@b.com',
        reason_code: 'wrong_tone',
      }),
    ];
    const r = aggregateRejectSignals(rows);
    expect(r.total_rejections).toBe(2);
    expect(r.by_reason.wrong_tone).toBe(2);
    // Only the categorized/sender-bearing row lands in the buckets.
    expect(Object.keys(r.wrong_tone.per_category)).toEqual(['inquiry']);
    expect(Object.keys(r.wrong_tone.per_sender)).toEqual(['a@b.com']);
  });
});
