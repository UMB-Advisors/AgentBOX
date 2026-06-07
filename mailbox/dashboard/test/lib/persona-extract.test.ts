import { describe, expect, it } from 'vitest';
import { type ExtractInput, extractPersona } from '@/lib/persona/extract';

const reorder1: ExtractInput = {
  draft_sent:
    "Hi Eric,\n\nThanks for the order — confirming 200 cases for May 15. We'll get the PO back today.\n\nBest,\nDustin",
  classification_category: 'reorder',
  inbox_subject: 'Re: order confirmation',
  inbox_body: 'Need 200 cases by May 15.',
  sent_at: '2026-05-01T10:00:00Z',
};

const reorder2: ExtractInput = {
  draft_sent:
    "Hi Sarah,\n\nThanks for the heads up. We'll ship 50 cases tomorrow morning.\n\nBest,\nDustin",
  classification_category: 'reorder',
  inbox_subject: 'Re: low stock',
  inbox_body: 'Running low.',
  sent_at: '2026-05-01T09:00:00Z',
};

const internal1: ExtractInput = {
  draft_sent: 'lol yeah lmk when you wanna sync',
  classification_category: 'internal',
  inbox_subject: null,
  inbox_body: null,
  sent_at: '2026-05-01T08:00:00Z',
};

describe('extractPersona', () => {
  it('returns empty markers for empty input', () => {
    const r = extractPersona([]);
    expect(r.source_email_count).toBe(0);
    expect(r.statistical_markers.avg_sentence_words).toBe(0);
    expect(r.statistical_markers.sign_off_top).toEqual([]);
    expect(r.category_exemplars).toEqual({});
  });

  it('extracts greeting and sign-off across rows', () => {
    const r = extractPersona([reorder1, reorder2]);
    expect(r.source_email_count).toBe(2);
    expect(r.statistical_markers.greeting_top[0]).toMatch(/^Hi /);
    expect(r.statistical_markers.sign_off_top).toContain('Dustin');
  });

  it('formality_score drops when casual markers + contractions appear', () => {
    const formal = extractPersona([reorder1]);
    const casual = extractPersona([internal1]);
    expect(formal.statistical_markers.formality_score).toBeGreaterThan(
      casual.statistical_markers.formality_score,
    );
  });

  it('per_category bucket has separate stats', () => {
    const r = extractPersona([reorder1, reorder2, internal1]);
    expect(r.statistical_markers.per_category.reorder?.sample_size).toBe(2);
    expect(r.statistical_markers.per_category.internal?.sample_size).toBe(1);
    // Internal is more casual → lower formality than reorder
    const reorderF = r.statistical_markers.per_category.reorder?.formality_score ?? 0;
    const internalF = r.statistical_markers.per_category.internal?.formality_score ?? 1;
    expect(reorderF).toBeGreaterThan(internalF);
  });

  it('category_exemplars caps at 3 per category and includes inbound excerpt', () => {
    const many: ExtractInput[] = Array.from({ length: 5 }, (_, i) => ({
      ...reorder1,
      sent_at: `2026-05-01T${String(i).padStart(2, '0')}:00:00Z`,
    }));
    const r = extractPersona(many);
    expect(r.category_exemplars.reorder?.length).toBe(3);
    expect(r.category_exemplars.reorder?.[0].inbound_subject).toBe('Re: order confirmation');
    expect(r.category_exemplars.reorder?.[0].sent_body).toContain('confirming 200 cases');
  });

  it('common_phrases excludes stop-words and is bigrams of content tokens', () => {
    const r = extractPersona([reorder1, reorder2]);
    // No stop-word-only bigrams should appear
    for (const phrase of r.statistical_markers.common_phrases) {
      const tokens = phrase.split(' ');
      expect(tokens.length).toBe(2);
      expect(tokens.every((t) => /^[a-z]+$/.test(t))).toBe(true);
    }
  });

  it('extracted_at is a valid ISO timestamp', () => {
    const r = extractPersona([reorder1]);
    expect(() => new Date(r.statistical_markers.extracted_at)).not.toThrow();
    expect(r.statistical_markers.extracted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
