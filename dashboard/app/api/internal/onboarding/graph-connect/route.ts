import { type NextRequest, NextResponse } from 'next/server';
import { connectGraph } from '@/lib/mail/connect-graph';
import { parseJson } from '@/lib/middleware/validate';
import { graphConnectBodySchema } from '@/lib/schemas/graph-connect';

export const dynamic = 'force-dynamic';

// POST /api/internal/onboarding/graph-connect — MBOX-358 (P2).
//
// Called from the onboarding wizard's email-connect step (Microsoft 365 branch).
// Shares all probe/persist logic with the settings "Add mailbox" route via
// connectGraph(); the ONBOARDING caller passes advanceOnboarding:true so a
// successful save records the mailbox + lands onboarding.stage='ingesting'.
//
// Two modes (see graphConnectBodySchema): mode:'test' runs the Graph app-only
// token + inbox probe only; mode:'save' persists ONLY on a passing probe (bad
// creds → 422, never stored). Co-located with the sibling imap-connect / advance
// routes; like them, not Caddy-gated (onboarding precedes basic_auth). The
// client secret is never echoed back.
export async function POST(req: NextRequest) {
  const b = await parseJson(req, graphConnectBodySchema);
  if (!b.ok) return b.response;
  const { status, body } = await connectGraph(b.data, { advanceOnboarding: true });
  return NextResponse.json(body, { status });
}
