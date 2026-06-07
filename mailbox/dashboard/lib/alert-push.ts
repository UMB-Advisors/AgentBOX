// MBOX-185 (FR-22) — email threshold-alert push decision logic.
//
// Pure functions: given the currently-firing alerts (from evaluateAlerts via
// gatherFiringAlerts) and the set of alert-keys already emailed today, decide
// which alerts warrant a NEW email this cycle. No DB, no mail — the route wires
// those in. Kept pure so the threshold→push→de-dupe decision is unit-testable
// with the mail/DB hooks mocked (the acceptance test).
//
// v1 policy (NARROW — Slack/Telegram + per-customer cadence deferred to M6):
//   • Only 'alarm' (red) severity pushes email. 'warn' (amber) shows on the
//     /status page + in the digest health block but does not interrupt with an
//     email — keeps the push channel high-signal.
//   • De-dupe is once-per-code-per-local-day, mirroring digest_sends: the key
//     is '<code>:<YYYY-MM-DD-local>'. A red threshold that stays breached all
//     day emails once, not every 5-min poll cycle.

import type { Alert } from '@/lib/alerts';

// The de-dupe key for an alert on a given local day. Encodes the code so each
// distinct red condition is tracked independently (memory red and disk red can
// both fire the same day), and the day so it resets at the local midnight
// boundary — same granularity as the daily digest.
export function alertKey(code: string, localDay: string): string {
  return `${code}:${localDay}`;
}

// An alert that crossed red and has NOT yet been emailed today.
export interface PendingAlertEmail {
  alert: Alert;
  alert_key: string;
}

// Decide which firing alerts to email this cycle.
//   firing      — output of evaluateAlerts (warn + alarm mixed)
//   localDay     — YYYY-MM-DD local calendar day (digest/day.ts:localDay)
//   alreadySent  — alert_keys already claimed in mailbox.alert_sends today
// Returns only alarm-severity alerts whose key is not in alreadySent.
export function selectAlertsToEmail(
  firing: Alert[],
  localDay: string,
  alreadySent: ReadonlySet<string>,
): PendingAlertEmail[] {
  return firing
    .filter((a) => a.severity === 'alarm')
    .map((a) => ({ alert: a, alert_key: alertKey(a.code, localDay) }))
    .filter((p) => !alreadySent.has(p.alert_key));
}
