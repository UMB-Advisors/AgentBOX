import { describe, expect, it } from 'vitest';
import { followupAgeHoursEnvVar, followupThresholdHours } from '@/lib/followup';

// MBOX-377 — pure unit tests for the follow-up threshold resolver. Mirrors the
// MBOX-134 urgency threshold tests (env override → per-category default →
// DEFAULT, with bad-value fallback).

describe('followupThresholdHours', () => {
  it('uses per-category defaults when env is unset', () => {
    expect(followupThresholdHours('inquiry', {})).toBe(48);
    expect(followupThresholdHours('scheduling', {})).toBe(24);
    expect(followupThresholdHours('follow_up', {})).toBe(72);
    expect(followupThresholdHours('escalate', {})).toBe(24);
  });

  it('falls back to DEFAULT for a category with no explicit default', () => {
    // spam_marketing has no follow-up default (it's excluded from tracking),
    // so the resolver returns the global default rather than throwing.
    expect(followupThresholdHours('spam_marketing', {})).toBe(48);
  });

  it('falls back to DEFAULT for a null/undefined category', () => {
    expect(followupThresholdHours(null, {})).toBe(48);
    expect(followupThresholdHours(undefined, {})).toBe(48);
  });

  it('honors a valid env override', () => {
    expect(followupThresholdHours('inquiry', { FOLLOWUP_AGE_HOURS_INQUIRY: '12' })).toBe(12);
    expect(followupThresholdHours('follow_up', { FOLLOWUP_AGE_HOURS_FOLLOW_UP: '96' })).toBe(96);
  });

  it('ignores a non-finite / non-positive / empty env value (falls back to default)', () => {
    expect(followupThresholdHours('inquiry', { FOLLOWUP_AGE_HOURS_INQUIRY: 'abc' })).toBe(48);
    expect(followupThresholdHours('inquiry', { FOLLOWUP_AGE_HOURS_INQUIRY: '-5' })).toBe(48);
    expect(followupThresholdHours('inquiry', { FOLLOWUP_AGE_HOURS_INQUIRY: '0' })).toBe(48);
    expect(followupThresholdHours('inquiry', { FOLLOWUP_AGE_HOURS_INQUIRY: '' })).toBe(48);
  });

  it('builds the env var name from the category', () => {
    expect(followupAgeHoursEnvVar('follow_up')).toBe('FOLLOWUP_AGE_HOURS_FOLLOW_UP');
    expect(followupAgeHoursEnvVar('inquiry')).toBe('FOLLOWUP_AGE_HOURS_INQUIRY');
  });
});
