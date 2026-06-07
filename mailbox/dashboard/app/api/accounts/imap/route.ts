import { type NextRequest, NextResponse } from 'next/server';
import { connectImap } from '@/lib/mail/connect-imap';
import { parseJson } from '@/lib/middleware/validate';
import { imapConnectBodySchema } from '@/lib/schemas/imap-connect';

export const dynamic = 'force-dynamic';

// POST /api/accounts/imap — MBOX-357 (P1 T6) settings "Add mailbox" (IMAP/SMTP).
//
// Operator-facing (Caddy basic_auth gated, NOT /api/internal) — reached from the
// Mailboxes settings page on a LIVE appliance, distinct from the onboarding
// wizard's connect step. Shares all probe/persist logic with the onboarding
// route via connectImap(), but passes advanceOnboarding:FALSE: a live box must
// not touch onboarding.stage (setEmail would regress it out of 'live'). On a
// live box the default account already has a real email, so createImapAccount
// inserts a NEW non-default account (multi-account add).
//
// Modes: 'test' runs the raw-socket probe only; 'save' persists ONLY on a
// passing probe (bad creds → 422). app-password is never echoed back.
export async function POST(req: NextRequest) {
  const b = await parseJson(req, imapConnectBodySchema);
  if (!b.ok) return b.response;
  const { status, body } = await connectImap(b.data, { advanceOnboarding: false });
  return NextResponse.json(body, { status });
}
