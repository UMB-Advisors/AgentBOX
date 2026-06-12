// dashboard/app/api/internal/gmail-bootstrap/route.ts
//
// STAQPRO-226 — read-side gate for first-install Gmail rate limiting.
//
// Pair to /api/internal/gmail-cycle-complete (write side). The cycle-complete
// route flips `bootstrap_complete=true` once the first cycle returns fewer
// messages than the bootstrap cap; this route exposes the current state +
// the limit n8n's Gmail Get should use this cycle.
//
// Mirrors the gmail-cooldown route pattern. n8n's MailBOX parent calls this
// before every cycle and reads `gmail_get_limit` into the Gmail Get node's
// `limit` parameter via expression binding.

import { NextResponse } from 'next/server';
import { getDefaultAccountEmail } from '@/lib/queries-accounts';
import {
  GMAIL_GET_LIMIT_BOOTSTRAP,
  GMAIL_GET_LIMIT_STEADY,
  getBootstrapState,
} from '@/lib/queries-system-state';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  // MBOX-466 (transport OPTION B — dashboard mints) — the MailBOX parent reads
  // `account_email` from this response and threads it into both the token-
  // authority call (GET /dashboard/api/internal/google/access-token?account_email=,
  // served by THIS dashboard container, NOT Hermes) and the Insert Inbox body so
  // resolveIngestAccountId stamps the right account_id. V1 single-account: the
  // inbox to ingest is the default/primary mailbox.accounts row (null while it
  // still holds the sentinel — n8n's Get Gmail Token then 404s and the cycle
  // no-ops rather than ingesting under the placeholder identity).
  const [state, accountEmail] = await Promise.all([getBootstrapState(), getDefaultAccountEmail()]);
  return NextResponse.json({
    bootstrap_complete: state.complete,
    gmail_get_limit: state.complete ? GMAIL_GET_LIMIT_STEADY : GMAIL_GET_LIMIT_BOOTSTRAP,
    messages_seen: state.messagesSeen,
    started_at: state.startedAt?.toISOString() ?? null,
    account_email: accountEmail,
  });
}
