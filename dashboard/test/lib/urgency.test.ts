import { describe, expect, it } from 'vitest';
import {
  ageHoursEnvVar,
  ageThresholdHours,
  evaluateUrgency,
  LOW_CONF_FLOOR,
  type UrgencyInput,
} from '@/lib/urgency';

// MBOX-134 — urgency evaluator unit tests. Pure function, no DB. The SQL query
// helper (getQueueWithUrgency / countUrgentDrafts) mirrors this logic; the
// route tests assert the SQL side against fixtures.

// A baseline "not urgent" input: high confidence, fresh, pending, no VIP,
// benign category. Each test perturbs exactly one axis.
function base(overrides: Partial<UrgencyInput> = {}): UrgencyInput {
  return {
    category: 'inquiry',
    confidence: 0.95,
    status: 'pending',
    ageHours: 0.1,
    isVip: false,
    ...overrides,
  };
}

describe('evaluateUrgency', () => {
  it('returns not-urgent with no signals for a fresh, confident, non-VIP pending draft', () => {
    const r = evaluateUrgency(base(), {});
    expect(r.urgent).toBe(false);
    expect(r.signals).toEqual([]);
  });

  it('flags escalate category', () => {
    const r = evaluateUrgency(base({ category: 'escalate', ageHours: 0.1 }), {});
    expect(r.urgent).toBe(true);
    expect(r.signals).toContain('escalate');
  });

  it('flags VIP sender', () => {
    const r = evaluateUrgency(base({ isVip: true }), {});
    expect(r.urgent).toBe(true);
    expect(r.signals).toContain('vip');
  });

  it('flags low confidence (< LOW_CONF_FLOOR)', () => {
    const r = evaluateUrgency(base({ confidence: LOW_CONF_FLOOR - 0.01 }), {});
    expect(r.urgent).toBe(true);
    expect(r.signals).toContain('low_conf');
  });

  it('does NOT flag low confidence exactly at the floor', () => {
    const r = evaluateUrgency(base({ confidence: LOW_CONF_FLOOR }), {});
    expect(r.signals).not.toContain('low_conf');
  });

  it('treats null/missing confidence as low_conf', () => {
    const r = evaluateUrgency(base({ confidence: null }), {});
    expect(r.signals).toContain('low_conf');
  });

  it('accepts confidence as a string (pg type-parser shape)', () => {
    const r = evaluateUrgency(base({ confidence: '0.50' }), {});
    expect(r.signals).toContain('low_conf');
  });

  it('flags aged when pending and older than the category threshold (inquiry default 4h)', () => {
    const r = evaluateUrgency(base({ ageHours: 5 }), {});
    expect(r.urgent).toBe(true);
    expect(r.signals).toContain('aged');
  });

  it('does NOT flag aged when within the category threshold', () => {
    const r = evaluateUrgency(base({ ageHours: 3 }), {});
    expect(r.signals).not.toContain('aged');
  });

  it('does NOT flag aged when not pending, even if old', () => {
    const r = evaluateUrgency(base({ ageHours: 100, status: 'edited' }), {});
    expect(r.signals).not.toContain('aged');
  });

  it('uses the 24h default for follow_up', () => {
    expect(
      evaluateUrgency(base({ category: 'follow_up', ageHours: 20 }), {}).signals,
    ).not.toContain('aged');
    expect(evaluateUrgency(base({ category: 'follow_up', ageHours: 25 }), {}).signals).toContain(
      'aged',
    );
  });

  it('uses the 1h default for escalate aging (separate from the escalate-category signal)', () => {
    // ageHours just over 1h but the escalate category itself already fires,
    // so assert aged via a non-escalate-but-1h check is not possible — instead
    // confirm escalate aged threshold is 1h via ageThresholdHours below. Here
    // we only confirm escalate aged at 2h adds 'aged' alongside 'escalate'.
    const r = evaluateUrgency(base({ category: 'escalate', ageHours: 2 }), {});
    expect(r.signals).toEqual(expect.arrayContaining(['escalate', 'aged']));
  });

  it('honors a per-category env override for the age threshold', () => {
    const env = { URGENCY_AGE_HOURS_INQUIRY: '1' };
    expect(evaluateUrgency(base({ ageHours: 2 }), env).signals).toContain('aged');
    // Without the override 2h would be under the 4h default.
    expect(evaluateUrgency(base({ ageHours: 2 }), {}).signals).not.toContain('aged');
  });

  it('ignores a junk env override and falls back to the default', () => {
    const env = { URGENCY_AGE_HOURS_INQUIRY: 'not-a-number' };
    expect(evaluateUrgency(base({ ageHours: 3 }), env).signals).not.toContain('aged');
    expect(evaluateUrgency(base({ ageHours: 5 }), env).signals).toContain('aged');
  });

  it('emits multiple signals in URGENCY_SIGNALS display order (escalate, vip, aged, low_conf)', () => {
    const r = evaluateUrgency(
      base({ category: 'escalate', isVip: true, ageHours: 50, confidence: 0.1 }),
      {},
    );
    expect(r.urgent).toBe(true);
    expect(r.signals).toEqual(['escalate', 'vip', 'aged', 'low_conf']);
  });
});

describe('ageThresholdHours / ageHoursEnvVar', () => {
  it('builds the env var name from the category', () => {
    expect(ageHoursEnvVar('follow_up')).toBe('URGENCY_AGE_HOURS_FOLLOW_UP');
    expect(ageHoursEnvVar('inquiry')).toBe('URGENCY_AGE_HOURS_INQUIRY');
  });

  it('returns the documented defaults', () => {
    expect(ageThresholdHours('inquiry', {})).toBe(4);
    expect(ageThresholdHours('reorder', {})).toBe(4);
    expect(ageThresholdHours('follow_up', {})).toBe(24);
    expect(ageThresholdHours('escalate', {})).toBe(1);
  });

  it('falls back to the global default for categories without a specific default', () => {
    expect(ageThresholdHours('scheduling', {})).toBe(4);
    expect(ageThresholdHours(null, {})).toBe(4);
  });

  it('reads a valid env override', () => {
    expect(ageThresholdHours('follow_up', { URGENCY_AGE_HOURS_FOLLOW_UP: '12' })).toBe(12);
  });
});
