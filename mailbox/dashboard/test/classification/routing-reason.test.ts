import { describe, expect, it } from 'vitest';
import type { Category } from '@/lib/classification/prompt';
import { routingReasonFor } from '@/lib/classification/prompt';

// STAQPRO-331 #3 — pure derivation of routing_reason from existing
// (draft_source, classification, confidence) columns. The badge UI is a
// thin wrapper; the logic lives here so it's testable without a DOM.

describe('routingReasonFor', () => {
  describe('local source', () => {
    it.each([
      'reorder',
      'scheduling',
      'follow_up',
      'internal',
      'inquiry',
    ])('returns local_category for %s with high confidence', (category) => {
      expect(routingReasonFor('local', category as Category, 0.92)).toBe('local_category');
    });

    it('returns unknown if local source paired with a CLOUD_CATEGORIES value', () => {
      // Should not happen in practice but be defensive — the helper does not
      // pretend to know it was a misroute, just that the explanation is
      // not one of the canonical paths.
      expect(routingReasonFor('local', 'escalate', 0.9)).toBe('unknown');
    });

    it('returns unknown when classification is null', () => {
      expect(routingReasonFor('local', null, 0.9)).toBe('unknown');
    });
  });

  describe('cloud source', () => {
    it('returns cloud_low_confidence when confidence < 0.75', () => {
      expect(routingReasonFor('cloud', 'inquiry', 0.5)).toBe('cloud_low_confidence');
    });

    it('returns cloud_category for escalate at high confidence', () => {
      expect(routingReasonFor('cloud', 'escalate', 0.95)).toBe('cloud_category');
    });

    it('returns cloud_category for unknown at high confidence', () => {
      expect(routingReasonFor('cloud', 'unknown', 0.8)).toBe('cloud_category');
    });

    it('returns cloud_low_confidence at exactly the boundary - 0.74', () => {
      expect(routingReasonFor('cloud', 'inquiry', 0.74)).toBe('cloud_low_confidence');
    });

    it('returns cloud_category at exactly the floor 0.75 for a CLOUD_CATEGORIES value', () => {
      expect(routingReasonFor('cloud', 'escalate', 0.75)).toBe('cloud_category');
    });

    it('returns unknown for a cloud LOCAL_CATEGORIES value at high confidence (should-not-happen path)', () => {
      // Same defensive shape as the local-source "should not happen" case.
      expect(routingReasonFor('cloud', 'reorder', 0.95)).toBe('unknown');
    });

    it('returns unknown when classification is null', () => {
      expect(routingReasonFor('cloud', null, 0.9)).toBe('unknown');
    });
  });

  describe('legacy sources', () => {
    it.each(['local_qwen3', 'cloud_haiku'] as const)('returns unknown for legacy %s', (src) => {
      expect(routingReasonFor(src, 'inquiry', 0.9)).toBe('unknown');
    });
  });
});
