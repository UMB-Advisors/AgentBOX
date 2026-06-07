import { describe, expect, it } from 'vitest';
import type { Alert, AlertCode, AlertSeverity } from '@/lib/alerts';
import { buildRecommendedActions, type DailyBriefSignals } from '@/lib/daily-brief';

// MBOX-379 — pure-eval tests for the Recommended Daily Actions composer. No DB,
// no clock; mirrors the lib/urgency.ts + lib/alerts.ts evaluator test style.

function alert(code: AlertCode, severity: AlertSeverity = 'alarm', message = 'msg'): Alert {
  return { code, severity, message, value: 1, threshold: 0 };
}

const QUIET: DailyBriefSignals = {
  urgent: { count: 0, bySignal: {} },
  stuckApproved: 0,
  pendingTotal: 0,
  firingAlerts: [],
};

describe('buildRecommendedActions', () => {
  it('returns the all-clear action when nothing is pending or wrong', () => {
    const actions = buildRecommendedActions(QUIET);
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('all-clear');
    expect(actions[0].tone).toBe('green');
    // No deep-link when the queue is empty.
    expect(actions[0].href).toBeUndefined();
  });

  it('all-clear links to the queue when drafts are pending but none urgent', () => {
    const actions = buildRecommendedActions({ ...QUIET, pendingTotal: 4 });
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('all-clear');
    expect(actions[0].href).toBe('/queue');
    expect(actions[0].detail).toContain('4 drafts pending');
  });

  it('ranks Gmail cooldown first as a blocking, red action', () => {
    const actions = buildRecommendedActions({
      ...QUIET,
      urgent: { count: 3, bySignal: { aged: 3 } },
      stuckApproved: 2,
      firingAlerts: [alert('GMAIL_RATE_LIMITED', 'alarm', 'cooldown active ~30 min')],
    });
    expect(actions[0].id).toBe('gmail-cooldown');
    expect(actions[0].tone).toBe('red');
    expect(actions[0].detail).toContain('cooldown active');
    // The cooldown alert is NOT also emitted as a generic health action.
    expect(actions.filter((a) => a.id.startsWith('alert-'))).toHaveLength(0);
  });

  it('surfaces stuck-approved sends with correct singular/plural', () => {
    expect(buildRecommendedActions({ ...QUIET, stuckApproved: 1 })[0].title).toContain(
      'Verify 1 send that may be stuck',
    );
    expect(buildRecommendedActions({ ...QUIET, stuckApproved: 3 })[0].title).toContain(
      'Verify 3 sends that may be stuck',
    );
  });

  it('summarizes the urgent breakdown in display order', () => {
    const actions = buildRecommendedActions({
      ...QUIET,
      urgent: { count: 4, bySignal: { low_conf: 1, escalate: 2, aged: 1 } },
    });
    const urgent = actions.find((a) => a.id === 'urgent-drafts');
    expect(urgent).toBeDefined();
    expect(urgent?.title).toContain('Review 4 urgent drafts first');
    // escalate → vip → aged → low_conf order (URGENCY_SIGNALS); vip absent.
    expect(urgent?.detail).toBe('Flagged: 2 escalation, 1 overdue, 1 low confidence.');
    expect(urgent?.href).toBe('/queue?folder=priority');
  });

  it('emits one action per non-dedicated health alert and excludes backlog/cooldown', () => {
    const actions = buildRecommendedActions({
      ...QUIET,
      urgent: { count: 5, bySignal: { aged: 5 } },
      firingAlerts: [
        alert('DRAFT_BACKLOG_AGED', 'alarm'), // excluded — covered by urgent
        alert('CLASSIFY_LAG', 'alarm', 'classify stalled'),
        alert('DISK_FREE_LOW', 'warn', 'disk low'),
      ],
    });
    const healthActions = actions.filter((a) => a.id.startsWith('alert-'));
    expect(healthActions.map((a) => a.id)).toEqual(['alert-classify_lag', 'alert-disk_free_low']);
    expect(healthActions[0].tone).toBe('red'); // alarm
    expect(healthActions[1].tone).toBe('orange'); // warn
    expect(healthActions[0].title).toBe('Classify Lag');
  });

  it('orders actions cooldown → stuck → urgent → health', () => {
    const actions = buildRecommendedActions({
      urgent: { count: 1, bySignal: { vip: 1 } },
      stuckApproved: 1,
      pendingTotal: 6,
      firingAlerts: [
        alert('GMAIL_RATE_LIMITED', 'alarm', 'cooldown'),
        alert('MEMORY_PRESSURE', 'warn', 'low mem'),
      ],
    });
    expect(actions.map((a) => a.id)).toEqual([
      'gmail-cooldown',
      'stuck-approved',
      'urgent-drafts',
      'alert-memory_pressure',
    ]);
    // The all-clear filler never appears alongside real actions.
    expect(actions.some((a) => a.id === 'all-clear')).toBe(false);
  });
});
