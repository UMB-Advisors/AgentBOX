import { type NextRequest, NextResponse } from 'next/server';
import { connectImap } from '@/lib/mail/connect-imap';
import { parseJson } from '@/lib/middleware/validate';
import { imapConnectBodySchema } from '@/lib/schemas/imap-connect';

export const dynamic = 'force-dynamic';

// POST /api/internal/onboarding/imap-connect — MBOX-357 (P1 T6 / FR-MP-6).
//
// Called from the onboarding wizard's email-connect step (IMAP branch). Shares
// all probe/persist logic with the settings "Add mailbox" route via
// connectImap(); the ONBOARDING caller passes advanceOnboarding:true so a
// successful save records the mailbox + lands onboarding.stage='ingesting'.
//
// Two modes (see imapConnectBodySchema): mode:'test' runs the raw-socket probe
// only; mode:'save' persists ONLY on a passing probe (bad creds → 422, never
// stored). Co-located with the sibling advance route; like it, not Caddy-gated
// (onboarding precedes basic_auth). The app-password is never echoed back.
export async function POST(req: NextRequest) {
  const b = await parseJson(req, imapConnectBodySchema);
  if (!b.ok) return b.response;
  const { status, body } = await connectImap(b.data, { advanceOnboarding: true });
  return NextResponse.json(body, { status });
}
