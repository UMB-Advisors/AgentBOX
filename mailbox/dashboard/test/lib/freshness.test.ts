import { describe, expect, it } from 'vitest';
import { formatDuration, freshnessFor } from '@/lib/freshness';

// STAQPRO-331 #8 — threshold semantics for the freshness chip. Pure
// function, no React. Boundary cases on each threshold matter — the
// operator's mental model treats them as inclusive on the lower bound.

describe('freshnessFor', () => {
  it('returns fresh just after creation', () => {
    expect(freshnessFor(0)).toBe('fresh');
    expect(freshnessFor(60_000)).toBe('fresh');
  });

  it('returns fresh up to 14m 59s', () => {
    expect(freshnessFor(14 * 60_000 + 59_000)).toBe('fresh');
  });

  it('crosses to neutral at exactly 15 minutes', () => {
    expect(freshnessFor(15 * 60_000)).toBe('neutral');
  });

  it('stays neutral through 1h 59m', () => {
    expect(freshnessFor(60 * 60_000 + 59 * 60_000)).toBe('neutral');
  });

  it('crosses to stale at exactly 2 hours', () => {
    expect(freshnessFor(2 * 60 * 60_000)).toBe('stale');
  });

  it('stays stale through 7h 59m', () => {
    expect(freshnessFor(7 * 60 * 60_000 + 59 * 60_000)).toBe('stale');
  });

  it('crosses to overdue at exactly 8 hours', () => {
    expect(freshnessFor(8 * 60 * 60_000)).toBe('overdue');
  });

  it('returns overdue for days-old drafts', () => {
    expect(freshnessFor(5 * 24 * 60 * 60_000)).toBe('overdue');
  });
});

describe('formatDuration', () => {
  it.each([
    [500, '0s'],
    [45_000, '45s'],
    [60_000, '1m'],
    [12 * 60_000 + 30_000, '12m'],
    [60 * 60_000, '1h'],
    [3 * 60 * 60_000 + 45 * 60_000, '3h'],
    [24 * 60 * 60_000, '1d'],
    [3 * 24 * 60 * 60_000, '3d'],
  ])('formats %dms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
