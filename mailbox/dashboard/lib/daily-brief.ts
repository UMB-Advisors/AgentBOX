// MBOX-379 — Daily Brief: "Recommended Daily Actions" composer.
//
// Pure, dependency-light logic (same shape as lib/urgency.ts and lib/alerts.ts:
// a function that takes query-result-shaped input and returns a ranked list).
// The Daily Brief page (app/daily-brief/page.tsx) feeds this from the existing
// digest payload (lib/queries-digest.ts:getDigestPayload) — there is NO new
// data path and NO new model call. The narrative (model-written) summary is a
// deferred follow-on per the MBOX-379 operator decision; this MVP is entirely
// deterministic so it's fast and unit-testable.
//
// Ranking (most blocking → least): a live Gmail cooldown stops all sends, so it
// leads; stuck-approved sends may be silent failures/dupes and need eyes next;
// then the urgent review queue; then any other actionable appliance-health
// alert; finally the "all clear" good-day state when nothing is pending action.

import type { Alert, AlertCode } from '@/lib/alerts';
import { URGENCY_SIGNAL_LABELS, URGENCY_SIGNALS, type UrgencySignal } from '@/lib/types';

export type ActionTone = 'red' | 'orange' | 'blue' | 'green';

// One recommended action row. `href` is an INTERNAL path (no basePath) — the
// page applies apiUrl() at render so the link survives the /dashboard basePath.
export interface RecommendedAction {
  id: string;
  title: string;
  detail: string;
  tone: ActionTone;
  href?: string;
  linkLabel?: string;
}

export interface DailyBriefSignals {
  // Urgent drafts still awaiting the operator. `count` is the true count;
  // `bySignal` is the per-signal tally for the detail line.
  urgent: { count: number; bySignal: Partial<Record<UrgencySignal, number>> };
  // Sends still at status='approved' after a send was attempted (the same
  // StuckApproved signal the queue banner + digest surface).
  stuckApproved: number;
  // Total drafts pending operator action (pending + edited) — context for the
  // all-clear state.
  pendingTotal: number;
  // Currently-firing health alerts (lib/alerts.ts:evaluateAlerts output, as
  // carried on the digest payload's health block).
  firingAlerts: Alert[];
}

// Alert codes already represented by a dedicated, higher-ranked action — kept
// out of the generic "appliance health" actions so we never double-surface:
//   GMAIL_RATE_LIMITED → the blocking cooldown action (rank 1)
//   DRAFT_BACKLOG_AGED → covered by "review urgent drafts" (aged drafts ARE
//     urgent via the MBOX-134 'aged' signal, so they're in the urgent count)
const ALERTS_WITH_DEDICATED_ACTION: ReadonlySet<AlertCode> = new Set<AlertCode>([
  'GMAIL_RATE_LIMITED',
  'DRAFT_BACKLOG_AGED',
]);

// "1 escalation, 2 overdue" — stable display order from URGENCY_SIGNALS.
function formatSignalBreakdown(bySignal: Partial<Record<UrgencySignal, number>>): string {
  const parts: string[] = [];
  for (const sig of URGENCY_SIGNALS) {
    const n = bySignal[sig];
    if (n && n > 0) parts.push(`${n} ${URGENCY_SIGNAL_LABELS[sig].toLowerCase()}`);
  }
  return parts.join(', ');
}

// 'CLASSIFY_LAG' → 'Classify Lag'. Title for a health-alert action; the alert's
// own message carries the actionable detail.
function humanizeAlertCode(code: AlertCode): string {
  return code
    .toLowerCase()
    .split('_')
    .map((w) => (w === 'n8n' ? 'n8n' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function buildRecommendedActions(s: DailyBriefSignals): RecommendedAction[] {
  const actions: RecommendedAction[] = [];

  // 1. Gmail cooldown — blocking: nothing can send while it's live. Derived
  //    from the firing GMAIL_RATE_LIMITED alert so there's one cooldown SoT.
  const cooldown = s.firingAlerts.find((a) => a.code === 'GMAIL_RATE_LIMITED');
  if (cooldown) {
    actions.push({
      id: 'gmail-cooldown',
      title: 'Gmail sending is paused',
      detail: cooldown.message,
      tone: 'red',
      href: '/status',
      linkLabel: 'View cooldown',
    });
  }

  // 2. Stuck-approved sends — possible silent failure or duplicate; verify first.
  if (s.stuckApproved > 0) {
    const n = s.stuckApproved;
    actions.push({
      id: 'stuck-approved',
      title: `Verify ${n} send${n === 1 ? '' : 's'} that may be stuck`,
      detail:
        'Still marked "approved" after a send was attempted. Verify in Gmail Sent, then retry or clear from the Approved folder.',
      tone: 'orange',
      href: '/queue?folder=approved',
      linkLabel: 'Open Approved',
    });
  }

  // 3. Urgent drafts awaiting review — escalate / VIP / overdue / low-confidence.
  if (s.urgent.count > 0) {
    const n = s.urgent.count;
    const breakdown = formatSignalBreakdown(s.urgent.bySignal);
    actions.push({
      id: 'urgent-drafts',
      title: `Review ${n} urgent draft${n === 1 ? '' : 's'} first`,
      detail: breakdown
        ? `Flagged: ${breakdown}.`
        : 'Drafts the urgency engine flagged for your attention.',
      tone: 'orange',
      href: '/queue?folder=priority',
      linkLabel: 'Open Priority',
    });
  }

  // 4. Other actionable appliance-health alerts (memory / swap-adjacent /
  //    classify-lag / disk / n8n failures / cost spike). One row each; the
  //    cooldown + backlog codes are excluded (covered above).
  for (const alert of s.firingAlerts) {
    if (ALERTS_WITH_DEDICATED_ACTION.has(alert.code)) continue;
    actions.push({
      id: `alert-${alert.code.toLowerCase()}`,
      title: humanizeAlertCode(alert.code),
      detail: alert.message,
      tone: alert.severity === 'alarm' ? 'red' : 'orange',
      href: '/status',
      linkLabel: 'Open Status',
    });
  }

  // 5. Nothing actionable → the good-day state.
  if (actions.length === 0) {
    const hasPending = s.pendingTotal > 0;
    actions.push({
      id: 'all-clear',
      title: 'Nothing needs your attention',
      detail: hasPending
        ? `${s.pendingTotal} draft${s.pendingTotal === 1 ? '' : 's'} pending, none urgent — review at your pace.`
        : 'The queue is clear.',
      tone: 'green',
      href: hasPending ? '/queue' : undefined,
      linkLabel: hasPending ? 'Open Queue' : undefined,
    });
  }

  return actions;
}
