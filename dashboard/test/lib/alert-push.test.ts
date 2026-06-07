import { describe, expect, it } from 'vitest';
import { alertKey, selectAlertsToEmail } from '@/lib/alert-push';
import type { Alert } from '@/lib/alerts';

// MBOX-185 (FR-22) — pure unit tests for the email threshold-alert push
// decision + de-dupe logic (no DB, no mail). Asserts the v1 policy: only
// alarm-severity alerts push, and a key already claimed today is suppressed
// (the "email once, not every poll cycle" acceptance criterion).

const DAY = '2026-05-28';

function alarm(code: Alert['code'], message = 'breached'): Alert {
  return { severity: 'alarm', code, message, value: 1, threshold: 0 };
}

function warn(code: Alert['code'], message = 'lagging'): Alert {
  return { severity: 'warn', code, message, value: 1, threshold: 0 };
}

describe('alertKey', () => {
  it('encodes code + local day', () => {
    expect(alertKey('MEMORY_PRESSURE', DAY)).toBe('MEMORY_PRESSURE:2026-05-28');
  });
});

describe('selectAlertsToEmail', () => {
  it('selects alarm-severity alerts not yet sent today', () => {
    const firing = [alarm('MEMORY_PRESSURE'), alarm('DISK_FREE_LOW')];
    const out = selectAlertsToEmail(firing, DAY, new Set());
    expect(out.map((p) => p.alert.code)).toEqual(['MEMORY_PRESSURE', 'DISK_FREE_LOW']);
    expect(out.map((p) => p.alert_key)).toEqual([
      'MEMORY_PRESSURE:2026-05-28',
      'DISK_FREE_LOW:2026-05-28',
    ]);
  });

  it('drops warn-severity alerts (only red pushes email in v1)', () => {
    const firing = [warn('CLASSIFY_LAG'), alarm('GMAIL_RATE_LIMITED')];
    const out = selectAlertsToEmail(firing, DAY, new Set());
    expect(out.map((p) => p.alert.code)).toEqual(['GMAIL_RATE_LIMITED']);
  });

  it('de-dupes a code already emailed today (no second email this cycle)', () => {
    const firing = [alarm('MEMORY_PRESSURE'), alarm('DISK_FREE_LOW')];
    const alreadySent = new Set(['MEMORY_PRESSURE:2026-05-28']);
    const out = selectAlertsToEmail(firing, DAY, alreadySent);
    expect(out.map((p) => p.alert.code)).toEqual(['DISK_FREE_LOW']);
  });

  it('returns nothing when every firing alarm was already emailed today', () => {
    const firing = [alarm('MEMORY_PRESSURE')];
    const alreadySent = new Set(['MEMORY_PRESSURE:2026-05-28']);
    expect(selectAlertsToEmail(firing, DAY, alreadySent)).toEqual([]);
  });

  it('a new local day re-arms the same code (key includes the day)', () => {
    const firing = [alarm('MEMORY_PRESSURE')];
    const sentYesterday = new Set(['MEMORY_PRESSURE:2026-05-27']);
    const out = selectAlertsToEmail(firing, DAY, sentYesterday);
    expect(out.map((p) => p.alert_key)).toEqual(['MEMORY_PRESSURE:2026-05-28']);
  });

  it('returns nothing when no alerts are firing', () => {
    expect(selectAlertsToEmail([], DAY, new Set())).toEqual([]);
  });
});
