import { NextResponse } from 'next/server';
import { type GmailMsgAction, triggerMsgActionWebhook } from '@/lib/n8n';
import { type InboxActionTarget, recordGmailActionState } from '@/lib/queries-inbox-actions';

// MBOX-369 — shared tail for the three Gmail write-through row actions
// (archive / delete / mark-read). The route applies local disposition first
// (returning the target row or null), then hands off here to fire the
// MailBOX-MsgAction webhook and shape the response.
//
// On webhook failure we return 200 with `gmail_synced: false` + a warning — NOT
// a 502. Rationale: unlike approve→send (where a webhook failure means the
// PRIMARY effect, the email, didn't happen), here the primary effect is the
// local queue disposition, which already succeeded. The Gmail mirror is a
// secondary side-effect; its failure is recorded (gmail_action_state='failed')
// for a future reconciler/retry and surfaced to the operator as a soft warning.
export async function finishWriteThrough(
  id: number,
  routeName: string,
  target: InboxActionTarget | null,
  gmailAction: GmailMsgAction,
): Promise<NextResponse> {
  if (!target) {
    return NextResponse.json({ error: 'Inbox message not found' }, { status: 404 });
  }
  const webhook = await triggerMsgActionWebhook(gmailAction, target.account_id, target.message_id);
  await recordGmailActionState(id, webhook.success ? 'ok' : 'failed');
  if (!webhook.success) {
    console.error(
      `POST /api/inbox-messages/${id}/${routeName} (gmail webhook) failed:`,
      webhook.error,
    );
    return NextResponse.json({
      success: true,
      id,
      gmail_synced: false,
      warning: `Applied locally but Gmail ${gmailAction} did not sync: ${webhook.error ?? 'unknown error'}`,
    });
  }
  return NextResponse.json({ success: true, id, gmail_synced: true });
}
