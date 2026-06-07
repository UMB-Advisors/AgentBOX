import { describe, expect, it } from 'vitest';
import { diffLines, diffStats } from '@/lib/diff/line-diff';

// STAQPRO-331 #4 — LCS line diff used by the EditDiff UI. Tests cover
// the cases an operator-edited draft actually hits: pure adds, pure
// removes, mixed changes, identical bodies, empty bodies.

describe('diffLines', () => {
  it('returns one equal op per line when bodies match', () => {
    const out = diffLines('alpha\nbeta\ngamma', 'alpha\nbeta\ngamma');
    expect(out).toEqual([
      { op: 'equal', text: 'alpha' },
      { op: 'equal', text: 'beta' },
      { op: 'equal', text: 'gamma' },
    ]);
  });

  it('detects a pure addition at the end', () => {
    const out = diffLines('alpha\nbeta', 'alpha\nbeta\ngamma');
    expect(out).toEqual([
      { op: 'equal', text: 'alpha' },
      { op: 'equal', text: 'beta' },
      { op: 'add', text: 'gamma' },
    ]);
  });

  it('detects a pure removal in the middle', () => {
    const out = diffLines('alpha\nbeta\ngamma', 'alpha\ngamma');
    expect(out).toEqual([
      { op: 'equal', text: 'alpha' },
      { op: 'remove', text: 'beta' },
      { op: 'equal', text: 'gamma' },
    ]);
  });

  it('detects a line replacement as remove + add', () => {
    const out = diffLines('alpha\nbeta\ngamma', 'alpha\nBETA\ngamma');
    // The LCS backtrace prefers remove-then-add for replaced lines.
    expect(out).toContainEqual({ op: 'remove', text: 'beta' });
    expect(out).toContainEqual({ op: 'add', text: 'BETA' });
    expect(out).toContainEqual({ op: 'equal', text: 'alpha' });
    expect(out).toContainEqual({ op: 'equal', text: 'gamma' });
  });

  it('handles empty before (all adds)', () => {
    // '' splits into [''], so the output is the two adds plus a synthetic
    // remove of the leading empty line. Exact ordering of the empty-string
    // op depends on the LCS backtrace; we only assert the set of ops.
    const out = diffLines('', 'alpha\nbeta');
    expect(out).toContainEqual({ op: 'add', text: 'alpha' });
    expect(out).toContainEqual({ op: 'add', text: 'beta' });
    expect(out.filter((l) => l.op === 'add')).toHaveLength(2);
  });

  it('handles empty after (all removes)', () => {
    const out = diffLines('alpha\nbeta', '');
    expect(out).toContainEqual({ op: 'remove', text: 'alpha' });
    expect(out).toContainEqual({ op: 'remove', text: 'beta' });
    expect(out.filter((l) => l.op === 'remove')).toHaveLength(2);
  });

  it('preserves order across multiple add/remove blocks', () => {
    const before = 'one\ntwo\nthree\nfour\nfive';
    const after = 'one\nTWO\nthree\nFOUR\nfive';
    const out = diffLines(before, after);
    const ops = out.map((l) => `${l.op}:${l.text}`);
    // 'one' equal must appear before 'three' equal which must appear before 'five' equal.
    expect(ops.indexOf('equal:one')).toBeLessThan(ops.indexOf('equal:three'));
    expect(ops.indexOf('equal:three')).toBeLessThan(ops.indexOf('equal:five'));
  });
});

describe('diffStats', () => {
  it('counts added and removed ops', () => {
    const lines = diffLines('a\nb\nc', 'a\nX\nY');
    const stats = diffStats(lines);
    expect(stats.added).toBe(2);
    expect(stats.removed).toBe(2);
  });

  it('returns zeros for identical bodies', () => {
    const stats = diffStats(diffLines('same', 'same'));
    expect(stats).toEqual({ added: 0, removed: 0 });
  });
});
