// dashboard/app/api/internal/alert-check/record/route.ts
//
// MBOX-185 (FR-22) — alert-email send-ledger claim. POSTed by the
// MailBOX-AlertCheck n8n workflow AFTER a successful Gmail send to claim the
// emailed alert_keys in mailbox.alert_sends (migration 035). Idempotent via the
// UNIQUE(alert_key) constraint: the first POST for a key inserts and counts as
// recorded; a later POST for the same key is a no-op.
//
// Claiming AFTER the send (not before) is deliberate — a failed Gmail send must
// not burn the day's slot for a still-red condition. n8n only reaches this node
// on the Gmail success branch.
//
// Body (zod — lib/schemas/alert-check.ts):
//   { alert_keys: string[], recipient?: string, subject?: string }
// Response: { recorded: number, alert_keys: string[] }

import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { recordAlertSendIfFirst } from '@/lib/queries-alert-sends';
import { alertCheckRecordBodySchema } from '@/lib/schemas/alert-check';

export const dynamic = 'force-dynamic';

// alert_key is '<CODE>:<YYYY-MM-DD>'; the code is everything before the final
// ':'. v1 only pushes alarm-severity alerts, so severity is always 'alarm'.
function codeFromKey(alertKey: string): string {
  return alertKey.slice(0, alertKey.lastIndexOf(':'));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const b = await parseJson(req, alertCheckRecordBodySchema);
  if (!b.ok) return b.response;
  const { alert_keys, recipient, subject } = b.data;

  try {
    let recorded = 0;
    for (const alert_key of alert_keys) {
      const claimed = await recordAlertSendIfFirst({
        alert_key,
        code: codeFromKey(alert_key),
        severity: 'alarm',
        recipient,
        subject,
      });
      if (claimed) recorded += 1;
    }
    return NextResponse.json({ recorded, alert_keys });
  } catch (error) {
    console.error('POST /api/internal/alert-check/record failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
