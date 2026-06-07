// dashboard/app/api/system/gmail-cooldown/route.ts
//
// STAQPRO-331 #5 — operator-facing read of the Gmail rate-limit cooldown.
// Powers the GmailCooldownBanner in the queue UI.
//
// Sibling to /api/internal/gmail-cooldown (n8n-facing): both read the same
// `mailbox.system_state.gmail_rate_limit_until` populated by the
// gmail-ratelimit-sweeper (STAQPRO-227). The internal route returns just
// the boolean gate; this one returns the full shape the operator UI needs
// (raw deadline + the recommended +1h safe-to-send timestamp + when we
// last detected the 429, so the banner can say "set 2 min ago").

import { NextResponse } from 'next/server';
import { clearGmailCooldown, getGmailCooldown } from '@/lib/queries-system-state';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const cooldown = await getGmailCooldown();
  return NextResponse.json({
    is_active: cooldown.isActive,
    until: cooldown.until?.toISOString() ?? null,
    set_at: cooldown.set_at?.toISOString() ?? null,
    recommended_safe_at: cooldown.recommended_safe_at?.toISOString() ?? null,
  });
}

// MBOX-107 — operator-driven force-resume. Clears the Gmail cooldown row
// so the n8n MailBOX parent's `Cooldown Active?` gate reopens and the
// dashboard's approve/retry transitions stop short-circuiting on the
// cooldown gate (lib/transitions.ts STAQPRO-231).
//
// Caddy basic_auth gates all operator-facing paths under /dashboard/api/
// at the public edge, so reaching this handler already implies the
// operator authenticated. No HMAC layered on top — same trust model as
// every other /api/* CRUD route (approve, reject, edit, retry).
//
// Idempotent: returns 200 with `cleared:false` if there was nothing to
// clear. DELETE was chosen over POST/clear because semantically the row
// is being deleted (set to NULL) — `clearGmailCooldown()` is the
// inverse of `setGmailCooldown()` and DELETE matches REST convention
// for "remove this resource state."
//
// CAUTION (carried in the UI banner copy): if Google's hidden
// probation is still active when the operator force-resumes, the next
// Gmail call will re-trigger the 429 AND extend the probation +15 min.
// The button is intentionally placed behind a confirmation prompt with
// the verify-Retry-After warning — see GmailCooldownBanner.tsx.
export async function DELETE(): Promise<NextResponse> {
  const result = await clearGmailCooldown();
  return NextResponse.json({
    cleared: result.cleared,
    previous_until: result.previous_until?.toISOString() ?? null,
  });
}
