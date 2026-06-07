// dashboard/app/api/internal/digest/route.ts
//
// MBOX-132 — daily digest render + send-decision route (Phase 2d).
//
// Called by the MailBOX-Digest n8n schedule workflow once per day at
// DIGEST_SEND_HOUR_LOCAL. The route is the single decision point: it resolves
// the recipient, computes today's local day, checks the de-dupe ledger, builds
// the payload (getDigestPayload — reuses MBOX-134's urgency engine for the
// urgent-untouched section) and renders the email HTML. n8n gates its Gmail
// send node on `should_send`; on a successful send it POSTs back to
// /api/internal/digest/record to claim the day in mailbox.digest_sends.
//
// Why GET returns html even when should_send=false: keeps the n8n workflow a
// single call + IF gate (no second fetch). When should_send=false the html is
// still returned for observability but n8n's IF node drops it.
//
// Send-from (open question resolved per the issue): appliance Gmail OAuth for
// v1, gated by the per-appliance DIGEST_SEND_FROM_GMAIL flag. When unset/false
// the route reports should_send=false reason='send_disabled' — a future
// separate-SMTP path would flip this without touching the payload/render code.
//
// Response shape (LOCKED — MailBOX-Digest reads should_send / recipient /
// subject / html / sent_on):
//   {
//     should_send: boolean,
//     reason: 'ok' | 'already_sent_today' | 'no_recipient' | 'send_disabled',
//     sent_on: string,            // YYYY-MM-DD local day
//     recipient: string | null,
//     subject: string,
//     html: string,
//   }

import { NextResponse } from 'next/server';
import { localDay } from '@/lib/digest/day';
import { resolveDigestRecipient } from '@/lib/digest/recipient';
import { renderDigest } from '@/lib/digest/render';
import { getDigestPayload, hasDigestSentOn } from '@/lib/queries-digest';

export const dynamic = 'force-dynamic';

type DigestReason = 'ok' | 'already_sent_today' | 'no_recipient' | 'send_disabled';

// Appliance-OAuth send path is the v1 default. Treated as ON unless explicitly
// '0'/'false' — a fresh box with the var unset still sends (the workflow only
// gets imported/activated deliberately, so unset === intended-on).
function sendFromGmailEnabled(env: Record<string, string | undefined>): boolean {
  const raw = (env.DIGEST_SEND_FROM_GMAIL ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

export async function GET(): Promise<NextResponse> {
  const env = process.env;
  const now = new Date();
  const sent_on = localDay(now);

  try {
    const recipient = await resolveDigestRecipient(env);
    const payload = await getDigestPayload({ env });
    const { subject, html } = renderDigest(payload, {
      now,
      queueUrl: env.DIGEST_QUEUE_URL ?? null,
    });

    let reason: DigestReason = 'ok';
    if (!sendFromGmailEnabled(env)) {
      reason = 'send_disabled';
    } else if (recipient === null) {
      reason = 'no_recipient';
    } else if (await hasDigestSentOn(sent_on)) {
      reason = 'already_sent_today';
    }

    return NextResponse.json({
      should_send: reason === 'ok',
      reason,
      sent_on,
      recipient: recipient?.email ?? null,
      subject,
      html,
    });
  } catch (error) {
    console.error('GET /api/internal/digest failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
