import { describe, expect, it } from 'vitest';
import {
  CLASSIFY_LAG_ALARM_MINUTES,
  CLASSIFY_LAG_WARN_MINUTES,
  COST_SPIKE_MIN_TRIGGER_USD,
  DISK_FREE_ALARM_PCT,
  DISK_FREE_WARN_PCT,
  DRAFT_BACKLOG_THRESHOLD_HOURS,
  evaluateAlerts,
  evaluateClassifyLag,
  evaluateCloudCostSpike,
  evaluateDiskFree,
  evaluateDraftBacklog,
  evaluateGmailRateLimit,
  evaluateMemoryPressure,
  evaluateN8nFailures,
} from '@/lib/alerts';

describe('evaluateDraftBacklog', () => {
  it('returns null when aged_count is 0', () => {
    expect(evaluateDraftBacklog({ aged_count: 0, threshold_hours: 4 })).toBeNull();
  });

  it('emits warn at any positive aged_count below alarm', () => {
    const a = evaluateDraftBacklog({ aged_count: 1, threshold_hours: 4 });
    expect(a?.severity).toBe('warn');
    expect(a?.code).toBe('DRAFT_BACKLOG_AGED');
    expect(a?.value).toBe(1);
  });

  it('emits alarm above 5', () => {
    const a = evaluateDraftBacklog({ aged_count: 8, threshold_hours: 4 });
    expect(a?.severity).toBe('alarm');
    expect(a?.value).toBe(8);
  });

  it('warn boundary: aged_count = 5 stays at warn (not yet alarm)', () => {
    const a = evaluateDraftBacklog({ aged_count: 5, threshold_hours: 4 });
    expect(a?.severity).toBe('warn');
  });
});

describe('evaluateN8nFailures', () => {
  it('returns null when total is 0 (no executions, nothing to rate)', () => {
    expect(evaluateN8nFailures({ failed_count: 0, total_count: 0 })).toBeNull();
  });

  it('returns null at 5% (boundary stays clean)', () => {
    expect(evaluateN8nFailures({ failed_count: 5, total_count: 100 })).toBeNull();
  });

  it('emits warn just above 5%', () => {
    const a = evaluateN8nFailures({ failed_count: 6, total_count: 100 });
    expect(a?.severity).toBe('warn');
  });

  it('emits alarm just above 20%', () => {
    const a = evaluateN8nFailures({ failed_count: 21, total_count: 100 });
    expect(a?.severity).toBe('alarm');
  });

  it('handles single-execution-all-failed (rate=1.0)', () => {
    const a = evaluateN8nFailures({ failed_count: 1, total_count: 1 });
    expect(a?.severity).toBe('alarm');
    expect(a?.value).toBe(1);
  });
});

describe('evaluateCloudCostSpike', () => {
  it('returns null when last_hour < min_trigger (cheap noise floor)', () => {
    expect(
      evaluateCloudCostSpike({
        last_hour_usd: 0.1,
        trailing_24h_usd: 0.001,
        min_trigger_usd: COST_SPIKE_MIN_TRIGGER_USD,
      }),
    ).toBeNull();
  });

  it('returns null when trailing_24h is 0 (no baseline to spike against)', () => {
    expect(
      evaluateCloudCostSpike({
        last_hour_usd: 1.0,
        trailing_24h_usd: 0,
        min_trigger_usd: COST_SPIKE_MIN_TRIGGER_USD,
      }),
    ).toBeNull();
  });

  it('emits warn at 4x trailing average above min_trigger', () => {
    // hourlyAvg = 24 / 24 = 1.0; last_hour = 4.0 → 4x
    const a = evaluateCloudCostSpike({
      last_hour_usd: 4.0,
      trailing_24h_usd: 24,
      min_trigger_usd: COST_SPIKE_MIN_TRIGGER_USD,
    });
    expect(a?.severity).toBe('warn');
    expect(a?.value).toBeCloseTo(4, 1);
  });

  it('emits alarm at 11x', () => {
    // hourlyAvg = 24 / 24 = 1.0; last_hour = 11.0 → 11x
    const a = evaluateCloudCostSpike({
      last_hour_usd: 11.0,
      trailing_24h_usd: 24,
      min_trigger_usd: COST_SPIKE_MIN_TRIGGER_USD,
    });
    expect(a?.severity).toBe('alarm');
  });
});

describe('evaluateMemoryPressure', () => {
  it('returns null when status is green', () => {
    expect(
      evaluateMemoryPressure({ status: 'green', memAvailableGiB: 4.0, minMemGiB: 1.5 }),
    ).toBeNull();
  });

  it('emits warn when status is amber', () => {
    const a = evaluateMemoryPressure({
      status: 'amber',
      memAvailableGiB: 1.6,
      minMemGiB: 1.5,
    });
    expect(a?.severity).toBe('warn');
    expect(a?.code).toBe('MEMORY_PRESSURE');
    expect(a?.value).toBeCloseTo(1.6, 2);
    expect(a?.threshold).toBe(1.5);
    expect(a?.message).toMatch(/within 200 MiB of threshold/);
  });

  it('emits alarm when status is red', () => {
    const a = evaluateMemoryPressure({
      status: 'red',
      memAvailableGiB: 0.9,
      minMemGiB: 1.5,
    });
    expect(a?.severity).toBe('alarm');
    expect(a?.code).toBe('MEMORY_PRESSURE');
    expect(a?.message).toMatch(/below threshold/);
    expect(a?.message).toMatch(/CUDA OOM/);
  });
});

// MBOX-185 (FR-22) — gmail rate-limit / classify-lag / disk-free evaluators.

describe('evaluateGmailRateLimit', () => {
  it('returns null when the cooldown is not active', () => {
    expect(evaluateGmailRateLimit({ active: false, minutes_remaining: 0 })).toBeNull();
  });

  it('emits alarm while the cooldown is active', () => {
    const a = evaluateGmailRateLimit({ active: true, minutes_remaining: 42 });
    expect(a?.severity).toBe('alarm');
    expect(a?.code).toBe('GMAIL_RATE_LIMITED');
    expect(a?.message).toMatch(/42 more min/);
  });
});

describe('evaluateClassifyLag', () => {
  it('returns null when there is no backlog (lag_minutes null)', () => {
    expect(evaluateClassifyLag({ lag_minutes: null })).toBeNull();
  });

  it('returns null below the warn threshold', () => {
    expect(evaluateClassifyLag({ lag_minutes: CLASSIFY_LAG_WARN_MINUTES })).toBeNull();
  });

  it('emits warn just above the warn threshold', () => {
    const a = evaluateClassifyLag({ lag_minutes: CLASSIFY_LAG_WARN_MINUTES + 1 });
    expect(a?.severity).toBe('warn');
    expect(a?.code).toBe('CLASSIFY_LAG');
  });

  it('emits alarm above the alarm threshold', () => {
    const a = evaluateClassifyLag({ lag_minutes: CLASSIFY_LAG_ALARM_MINUTES + 1 });
    expect(a?.severity).toBe('alarm');
    expect(a?.message).toMatch(/dark inbox/);
  });
});

describe('evaluateDiskFree', () => {
  it('returns null when total is 0 (no disk info)', () => {
    expect(evaluateDiskFree({ free_bytes: 0, total_bytes: 0 })).toBeNull();
  });

  it('returns null when free fraction is comfortable', () => {
    expect(evaluateDiskFree({ free_bytes: 50, total_bytes: 100 })).toBeNull();
  });

  it('emits warn below the warn pct but above alarm', () => {
    // 8% free: below 10% warn, above 5% alarm
    const a = evaluateDiskFree({ free_bytes: 8, total_bytes: 100 });
    expect(a?.severity).toBe('warn');
    expect(a?.code).toBe('DISK_FREE_LOW');
  });

  it('emits alarm below the alarm pct', () => {
    // 3% free: below 5% alarm
    const a = evaluateDiskFree({ free_bytes: 3, total_bytes: 100 });
    expect(a?.severity).toBe('alarm');
    expect(a?.value).toBeCloseTo(0.03, 2);
  });

  it('exposes pct thresholds as constants', () => {
    expect(DISK_FREE_WARN_PCT).toBe(0.1);
    expect(DISK_FREE_ALARM_PCT).toBe(0.05);
  });
});

describe('evaluateAlerts', () => {
  const NULL_INPUTS = {
    draftBacklog: null,
    n8nFailures: null,
    cloudCostSpike: null,
    memoryPressure: null,
    gmailRateLimit: null,
    classifyLag: null,
    diskFree: null,
  } as const;

  it('returns empty array when all inputs are null', () => {
    expect(evaluateAlerts({ ...NULL_INPUTS })).toEqual([]);
  });

  it('omits non-firing alerts but includes firing ones', () => {
    const result = evaluateAlerts({
      ...NULL_INPUTS,
      draftBacklog: { aged_count: 8, threshold_hours: 4 },
      n8nFailures: { failed_count: 1, total_count: 1000 },
      memoryPressure: { status: 'green', memAvailableGiB: 4.0, minMemGiB: 1.5 },
    });
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe('DRAFT_BACKLOG_AGED');
    expect(result[0].severity).toBe('alarm');
  });

  it('includes memory pressure alarm alongside other firing alerts', () => {
    const result = evaluateAlerts({
      ...NULL_INPUTS,
      memoryPressure: { status: 'red', memAvailableGiB: 0.8, minMemGiB: 1.5 },
    });
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe('MEMORY_PRESSURE');
    expect(result[0].severity).toBe('alarm');
  });

  it('folds in the FR-22 alerts (gmail rate-limit + disk-free)', () => {
    const result = evaluateAlerts({
      ...NULL_INPUTS,
      gmailRateLimit: { active: true, minutes_remaining: 10 },
      diskFree: { free_bytes: 3, total_bytes: 100 },
    });
    const codes = result.map((a) => a.code).sort();
    expect(codes).toEqual(['DISK_FREE_LOW', 'GMAIL_RATE_LIMITED']);
  });

  it('preserves the threshold-hours metadata constant', () => {
    expect(DRAFT_BACKLOG_THRESHOLD_HOURS).toBe(4);
  });
});
