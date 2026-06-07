// dashboard/app/api/internal/gmail-cooldown/route.ts
//
// STAQPRO-228 — read-side gate for the Gmail per-user 429 ratchet.
//
// Pair to STAQPRO-227's gmail-ratelimit-sweeper (write side). The sweeper
// records the latest "Retry after" hint into mailbox.system_state.
// gmail_rate_limit_until; this route exposes that flag to n8n so the
// MailBOX parent workflow can short-circuit the Schedule → Gmail Get
// path while we're still in Google's probation window.
//
// Without this gate, n8n's 5-min Schedule trigger fires Gmail Get every
// cycle regardless of cooldown state, and each fresh 429 ratchets Google's
// per-user probation further out (memory: gmail_ratelimit_probation.md).
//
// GET because the n8n IF node only needs the boolean. Trivial enough to
// poll on every cycle.

import { NextResponse } from 'next/server';
import { getGmailCooldown } from '@/lib/queries-system-state';

export const dynamic = 'force-dynamic';

// Buffer past Google's last "Retry-After" hint before reopening the gate.
// Google's hint is a MIN wait, not a guarantee — if we probe right at the
// hint timestamp and probation hasn't actually cleared, Google ratchets +15
// min (per gmail_ratelimit_probation memory). Live evidence 2026-05-04:
// 22:15 cycle probed at hint+0, got fresh 429, +15 min. Without buffer the
// 5-min-probe / +15-min-ratchet loop NEVER clears.
//
// Originally shipped at 20 min on the theory that probation would decay
// faster than +15 min extension cost. Live evidence 2026-05-04 23:15:19
// (cycle 4858): 25 min past hint STILL got fresh 429 → +15 min ratchet
// to 23:30:20. Google's hidden probation runs deeper than the hint
// suggests when triggered by sustained abuse (12+ pre-deploy 429s).
//
// Bumped to 60 min as a stopgap. Probes now ~65 min apart — probation
// has wall-clock time to actually decay. STAQPRO-229 will replace this
// constant with exponential backoff (double buffer per consecutive 429,
// reset on success).
const BUFFER_MS = 60 * 60 * 1000;

export async function GET(): Promise<NextResponse> {
  const cooldown = await getGmailCooldown();
  const effectiveUntil = cooldown.until ? new Date(cooldown.until.getTime() + BUFFER_MS) : null;
  const inCooldown = effectiveUntil !== null && effectiveUntil.getTime() > Date.now();
  return NextResponse.json({
    in_cooldown: inCooldown,
    until: effectiveUntil?.toISOString() ?? null,
  });
}
