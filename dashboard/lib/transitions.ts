import { sql } from 'kysely';
import { NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { triggerSendWebhook } from '@/lib/n8n';
import { getDraftProviderContext } from '@/lib/queries-accounts';
import { getGmailCooldown, getMailCooldown } from '@/lib/queries-system-state';
import type { DraftStatus } from '@/lib/types';

// Shared helper for approve/retry, which both transition a draft to
// `status='approved'` and fire the n8n send webhook (STAQPRO-140).
// Differences between the two routes are passed as options:
//   - approve allows from {pending, edited, failed}, doesn't touch error_message
//   - retry only allows from {failed}, clears error_message
//
// Webhook failure does NOT roll back the status update — operator can re-fire
// via /retry, which keeps the row at 'approved' and re-tries the webhook
// without any state surgery.

interface TransitionOptions {
  fromStates: ReadonlyArray<DraftStatus>;
  fromStatesLabel: string; // surfaced in the 409 error message
  clearError: boolean;
  routeName: string; // for log breadcrumbs
  // STAQPRO-227 — when true, also stamps drafts.last_retry_at = NOW() in the
  // same transaction as the status flip. Used by the retry route to record
  // when this draft last hit the n8n send webhook so the cooldown check can
  // gate subsequent retries. Approve doesn't set this — it's not a "retry".
  setLastRetryAt?: boolean;
  // MBOX-16 — actor recorded in the migration-009 state_transitions trigger
  // via the mailbox.actor GUC. Defaults to 'operator' (the human approve/retry
  // path); the auto-send path passes 'auto' so the audit log distinguishes a
  // rule-driven send from an operator click. The transition reason defaults to
  // `routeName`; override it (e.g. 'auto_send_rule') when the route name isn't
  // the meaningful reason.
  actor?: string;
  reason?: string;
}

export async function transitionToApprovedAndSend(
  id: number,
  opts: TransitionOptions,
): Promise<NextResponse> {
  // STAQPRO-231 — single-source-of-truth Gmail cooldown gate. Both approve
  // and retry funnel through here; checking once here means the approve
  // route gets the same protection retry already had. Returning 429 BEFORE
  // the status flip keeps the row at its source state (`pending`/`edited`),
  // so the operator can re-attempt cleanly once the cooldown clears — no
  // stuck-at-approved cleanup needed.
  //
  // Today's 2026-05-08 incident (STAQPRO-271) was caused by Approve firing
  // through this function without consulting `mailbox.system_state`, which
  // gmail-ratelimit-sweeper had already populated for an active cooldown.
  // Each in-cooldown send extends the penalty (Google's per-user probation),
  // so blocking the call early is the only safe move.
  // MBOX-357 (P1 T5) — resolve the draft's transport so the cooldown gate and
  // the send webhook are provider-correct: a Gmail 429 must not pause an IMAP
  // send and vice-versa (DR-57 / migration 039). Gmail keeps the EXACT prior
  // gate (getGmailCooldown reads the default-account gmail bucket the
  // ratelimit-sweeper writes); IMAP gates on its own (account, provider) bucket.
  // Null ctx (draft id missing) → Gmail default; the status flip below then
  // returns the not-found 409, so no extra branch is needed here.
  const ctx = await getDraftProviderContext(id);
  const provider = ctx?.provider ?? 'gmail';
  const sysCooldown =
    ctx && ctx.provider !== 'gmail'
      ? await getMailCooldown(ctx.account_id, ctx.provider)
      : await getGmailCooldown();
  if (sysCooldown.isActive && sysCooldown.until) {
    return NextResponse.json(
      {
        error: provider === 'gmail' ? 'gmail_rate_limit_active' : 'mail_rate_limit_active',
        message: `${provider === 'imap' ? 'IMAP/SMTP host' : 'Gmail'} is rate-limiting this account. Send paused.`,
        provider,
        next_retry_at: sysCooldown.until.toISOString(),
      },
      { status: 429 },
    );
  }

  // Step 1: flip status to 'approved' (only from the allowed source states).
  // Wrap in a transaction so we can SET LOCAL the actor/reason GUCs that the
  // mailbox.state_transitions trigger reads (STAQPRO-185). Without these,
  // the trigger still fires but logs actor='system'.
  try {
    const db = getKysely();
    const rows = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('mailbox.actor', ${opts.actor ?? 'operator'}, true)`.execute(trx);
      await sql`SELECT set_config('mailbox.transition_reason', ${opts.reason ?? opts.routeName}, true)`.execute(
        trx,
      );
      return trx
        .updateTable('drafts')
        .set({
          status: 'approved',
          updated_at: sql<string>`NOW()`,
          ...(opts.clearError ? { error_message: null } : {}),
          ...(opts.setLastRetryAt ? { last_retry_at: sql<string>`NOW()` } : {}),
        })
        .where('id', '=', id)
        .where('status', 'in', opts.fromStates as readonly string[])
        .returning(['id', 'status'])
        .execute();
    });
    if (rows.length === 0) {
      return NextResponse.json(
        { error: `Draft not in ${opts.fromStatesLabel} state` },
        { status: 409 },
      );
    }
  } catch (error) {
    console.error(`POST /api/drafts/${id}/${opts.routeName} (status update) failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }

  // Step 2: fire the n8n webhook (provider-routed — gmail → mailbox-send,
  // imap → mailbox-imap-send).
  const webhookResult = await triggerSendWebhook(id, provider);
  if (!webhookResult.success) {
    console.error(
      `POST /api/drafts/${id}/${opts.routeName} (webhook) failed:`,
      webhookResult.error,
    );
    // STAQPRO-271 — persist the send-failure detail to drafts.error_message
    // so the operator has a forensic trail without grepping execution_data.
    // Before this, the 502 wire response carried the cause but the row only
    // showed status='approved' with no clue why send failed (AC #4 in the
    // 2026-05-08 incident writeup). Best-effort: a write failure here mustn't
    // shadow the original webhook error in the response, so swallow + log.
    const errMsg = webhookResult.error ?? 'Send webhook failed (no detail)';
    try {
      const db = getKysely();
      await db
        .updateTable('drafts')
        .set({
          error_message: errMsg,
          updated_at: sql<string>`NOW()`,
        })
        .where('id', '=', id)
        .execute();
    } catch (persistErr) {
      console.error(
        `POST /api/drafts/${id}/${opts.routeName} (error_message persist) failed:`,
        persistErr,
      );
    }
    return NextResponse.json({ success: false, draft_id: id, error: errMsg }, { status: 502 });
  }

  return NextResponse.json({
    success: true,
    draft_id: id,
    webhook_response: webhookResult.response,
  });
}
