import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseParams } from '@/lib/middleware/validate';
import { getGmailCooldown } from '@/lib/queries-system-state';
import { idParamSchema } from '@/lib/schemas/common';
import { transitionToApprovedAndSend } from '@/lib/transitions';

export const dynamic = 'force-dynamic';

// STAQPRO-227 — server-side cooldown for the operator's retry button.
// Five minutes is conservative against Google's per-user Gmail rate-limit
// probation (each rate-limited call extends the cooldown +15 min).
const RETRY_COOLDOWN_MS = 5 * 60 * 1000;

export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;

  // STAQPRO-227 stretch — consult system-wide Gmail cooldown FIRST. If
  // gmail-ratelimit-sweeper recently observed a 429 from any Gmail call
  // (Gmail Get cycle OR a previous mailbox-send), block ALL retries until
  // the stated retry-after passes. Single source of truth for "Gmail is
  // angry at us right now."
  const sysCooldown = await getGmailCooldown();
  if (sysCooldown.isActive && sysCooldown.until) {
    return NextResponse.json(
      {
        error: 'gmail_rate_limit_active',
        message: 'Gmail is rate-limiting this account. All retries paused.',
        next_retry_at: sysCooldown.until.toISOString(),
      },
      { status: 429 },
    );
  }

  // Per-draft cooldown gate. Read last_retry_at separately from the
  // transition transaction — keeps the rate-limit check cheap (single SELECT)
  // and the response shape distinct from the 409 "wrong source state" path.
  const db = getKysely();
  const row = await db
    .selectFrom('drafts')
    .select(['last_retry_at'])
    .where('id', '=', p.data.id)
    .executeTakeFirst();
  if (row?.last_retry_at) {
    const lastMs = new Date(row.last_retry_at).getTime();
    const elapsed = Date.now() - lastMs;
    if (elapsed < RETRY_COOLDOWN_MS) {
      const nextRetryAt = new Date(lastMs + RETRY_COOLDOWN_MS).toISOString();
      return NextResponse.json(
        {
          error: 'retry_cooldown',
          message: 'Retry rate-limited; wait before retrying again.',
          next_retry_at: nextRetryAt,
        },
        { status: 429 },
      );
    }
  }

  // STAQPRO-202 — retry only advances rows stuck at status='approved'. The
  // 'failed' status was retired in migration 016 (MailBOX-Send no longer
  // flips to 'failed'; Gmail Reply errors leave the row at 'approved'). The
  // stuck-at-approved case covers: dashboard flipped status='approved'
  // before firing the n8n webhook, but n8n crashed mid-send OR Mark Sent
  // failed after Gmail Reply succeeded. Operator-side mitigation for the
  // resulting double-send risk: the StuckApproved UI surfaces a 5s arm
  // window + "may have already sent — verify in Gmail Sent" warning before
  // firing.
  return transitionToApprovedAndSend(p.data.id, {
    fromStates: ['approved'],
    fromStatesLabel: 'approved',
    clearError: true,
    routeName: 'retry',
    setLastRetryAt: true,
  });
}
