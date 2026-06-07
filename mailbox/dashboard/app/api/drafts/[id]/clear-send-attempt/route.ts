import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { idParamSchema } from '@/lib/schemas/common';
import { clearSendAttemptBodySchema } from '@/lib/schemas/drafts';

export const dynamic = 'force-dynamic';

// STAQPRO-IDEM-2026-05-22 — operator-driven recovery from a held send lock.
//
// The MailBOX-Send CAS lock (drafts.send_attempt_at) is set by Acquire Send
// Lock immediately before Gmail Reply, and cleared by Mark Sent on success.
// If Mark Sent crashes after Gmail Reply succeeded, the lock stays set and
// the next webhook call returns 409 "send_attempt_at already set — verify
// in Gmail Sent..." — by design, to prevent the 3-dupes class.
//
// This route lets the operator clear the lock AFTER they've verified in
// Gmail Sent that the reply did NOT actually go out. The body requires
// `verified_in_gmail_sent: true` as an explicit attestation. The audit
// trigger (migration 009) records actor='operator' + reason='clear_send_attempt'
// so the state-transitions log captures who unlocked and when.
//
// What this route does NOT do:
//   - Does not flip status — only the lock column. Operator then clicks Retry
//     in StuckApproved to actually re-send.
//   - Does not handle the "yes the email DID send, just mark it" path. That's
//     a separate operator action (current path: manual SQL); a follow-up route
//     can wrap it once the UX is needed.
//
// 409s:
//   - draft not in 'approved' state (already moved on, lock-clear is moot)
//   - send_attempt_at is already NULL (no lock to clear)
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const b = await parseJson(req, clearSendAttemptBodySchema);
  if (!b.ok) return b.response;

  try {
    const db = getKysely();
    const result = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('mailbox.actor', 'operator', true)`.execute(trx);
      await sql`SELECT set_config('mailbox.transition_reason', 'clear_send_attempt', true)`.execute(
        trx,
      );

      const cleared = await trx
        .updateTable('drafts')
        .set({
          send_attempt_at: null,
          error_message: null,
          updated_at: sql<string>`NOW()`,
        })
        .where('id', '=', id)
        .where('status', '=', 'approved')
        .where('send_attempt_at', 'is not', null)
        .returning(['id', 'status', 'send_attempt_at'])
        .execute();
      return cleared[0] ?? null;
    });
    if (result === null) {
      return NextResponse.json(
        {
          error:
            'Draft not in approved state with a held send lock — nothing to clear. ' +
            'Either the draft moved on (sent/rejected) or the lock was already cleared.',
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true, draft: result });
  } catch (error) {
    console.error(`POST /api/drafts/${id}/clear-send-attempt failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
