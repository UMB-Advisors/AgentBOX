// grammar-dispatch.test.ts — MBOX-120.
//
// Pure unit tests for the constrained-decoding dispatch. No DB, no network,
// no GGUF — just the env flag, the category table, and the GBNF file reads.
// Hermetic: each test snapshots + restores CONSTRAINED_DECODING_ENABLED.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { constrainedDecodingEnabled, grammarForCategory } from './grammar-dispatch';

describe('grammar-dispatch', () => {
  const original = process.env.CONSTRAINED_DECODING_ENABLED;

  beforeEach(() => {
    delete process.env.CONSTRAINED_DECODING_ENABLED;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CONSTRAINED_DECODING_ENABLED;
    } else {
      process.env.CONSTRAINED_DECODING_ENABLED = original;
    }
  });

  describe('constrainedDecodingEnabled', () => {
    it('is false when unset (spike default)', () => {
      expect(constrainedDecodingEnabled()).toBe(false);
    });

    it("accepts '1' and 'true' (case-insensitive)", () => {
      process.env.CONSTRAINED_DECODING_ENABLED = '1';
      expect(constrainedDecodingEnabled()).toBe(true);
      process.env.CONSTRAINED_DECODING_ENABLED = 'true';
      expect(constrainedDecodingEnabled()).toBe(true);
      process.env.CONSTRAINED_DECODING_ENABLED = 'TRUE';
      expect(constrainedDecodingEnabled()).toBe(true);
    });

    it('treats other values as off', () => {
      process.env.CONSTRAINED_DECODING_ENABLED = '0';
      expect(constrainedDecodingEnabled()).toBe(false);
      process.env.CONSTRAINED_DECODING_ENABLED = 'yes';
      expect(constrainedDecodingEnabled()).toBe(false);
    });
  });

  describe('grammarForCategory', () => {
    it('returns null for every category when the flag is off', () => {
      expect(grammarForCategory('reorder')).toBeNull();
      expect(grammarForCategory('scheduling')).toBeNull();
      expect(grammarForCategory('inquiry')).toBeNull();
    });

    it('returns a non-empty GBNF with a root rule for reorder + scheduling when on', () => {
      process.env.CONSTRAINED_DECODING_ENABLED = '1';

      const reorder = grammarForCategory('reorder');
      expect(reorder).not.toBeNull();
      expect((reorder ?? '').length).toBeGreaterThan(0);
      expect(reorder).toMatch(/root\s+::=/);

      const scheduling = grammarForCategory('scheduling');
      expect(scheduling).not.toBeNull();
      expect((scheduling ?? '').length).toBeGreaterThan(0);
      expect(scheduling).toMatch(/root\s+::=/);
    });

    it('returns null for non-constrained categories even when on', () => {
      process.env.CONSTRAINED_DECODING_ENABLED = '1';
      expect(grammarForCategory('inquiry')).toBeNull();
      expect(grammarForCategory('escalate')).toBeNull();
      expect(grammarForCategory('follow_up')).toBeNull();
    });
  });
});
