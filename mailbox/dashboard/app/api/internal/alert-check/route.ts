// dashboard/app/api/internal/alert-check/route.ts
//
// MBOX-185 (FR-22) — threshold-alert email decision + render route.
//
// Called by the MailBOX-AlertCheck n8n schedule workflow on a poll interval.
// Single decision point, mirroring the daily-digest route: it gathers the
// currently-firing alerts (the SAME evaluateAlerts surface the /status page
// uses — no second stats engine), filters to alarm-severity alerts NOT already
// emailed today (mailbox.alert_sends de-dupe, migration 035), resolves the
// recipient + builds one combined alert email. n8n gates its Gmail send node on
// `should_send`; on a successful send it POSTs the claimed alert_keys back to
// /api/internal/alert-check/record to claim them in the ledger.
//
// Claiming AFTER the send (not before) is deliberate — a failed Gmail send must
// not burn the day's slot for a still-red condition, otherwise a transient send
// error would suppress the alert until tomorrow. Same ordering as the digest.
//
// Send-from: appliance Gmail OAuth (same path as the digest worker), gated by
// ALERT_SEND_FROM_GMAIL (defaults ON when unset — the workflow is imported
// deliberately, so unset === intended-on, matching DIGEST_SEND_FROM_GMAIL).
//
// Response shape (LOCKED — MailBOX-AlertCheck reads should_send / recipient /
// subject / html / alert_keys):
//   {
//     should_send: boolean,
//     reason: 'ok' | 'no_alerts' | 'no_recipient' | 'send_disabled',
//     alert_keys: string[],   // claimed back via /record on success
//     recipient: string | null,
//     subject: string,
//     html: string,
//   }

import { NextResponse } from 'next/server';
import { gatherFiringAlerts } from '@/lib/alert-inputs';
import { selectAlertsToEmail } from '@/lib/alert-push';
import { renderAlertEmail } from '@/lib/digest/alert-render';
import { localDay } from '@/lib/digest/day';
import { resolveDigestRecipient } from '@/lib/digest/recipient';
import { getSentAlertKeysForDay } from '@/lib/queries-alert-sends';

export const dynamic = 'force-dynamic';

type AlertCheckReason = 'ok' | 'no_alerts' | 'no_recipient' | 'send_disabled';

// Appliance-OAuth send path is the v1 default. Treated as ON unless explicitly
// '0'/'false' — mirrors DIGEST_SEND_FROM_GMAIL in the digest route.
function sendFromGmailEnabled(env: Record<string, string | undefined>): boolean {
  const raw = (env.ALERT_SEND_FROM_GMAIL ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

export async function GET(): Promise<NextResponse> {
  const env = process.env;
  const now = new Date();
  const day = localDay(now);

  try {
    const firing = await gatherFiringAlerts();
    const alreadySent = await getSentAlertKeysForDay(day);
    const pending = selectAlertsToEmail(firing, day, alreadySent);
    const alerts = pending.map((p) => p.alert);
    const alert_keys = pending.map((p) => p.alert_key);

    const recipient = await resolveDigestRecipient(env);
    const { subject, html } = renderAlertEmail(alerts, now);

    let reason: AlertCheckReason = 'ok';
    if (!sendFromGmailEnabled(env)) {
      reason = 'send_disabled';
    } else if (alerts.length === 0) {
      reason = 'no_alerts';
    } else if (recipient === null) {
      reason = 'no_recipient';
    }

    return NextResponse.json({
      should_send: reason === 'ok',
      reason,
      alert_keys,
      recipient: recipient?.email ?? null,
      subject,
      html,
    });
  } catch (error) {
    console.error('GET /api/internal/alert-check failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
