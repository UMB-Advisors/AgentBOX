import { type NextRequest, NextResponse } from 'next/server';
import { connectGraph } from '@/lib/mail/connect-graph';
import { parseJson } from '@/lib/middleware/validate';
import { graphConnectBodySchema } from '@/lib/schemas/graph-connect';

export const dynamic = 'force-dynamic';

// POST /api/accounts/microsoft — MBOX-358 (P2) settings "Add mailbox" (M365/Graph).
//
// Operator-facing (Caddy basic_auth gated, NOT /api/internal) — reached from the
// Inboxes settings page on a LIVE appliance, distinct from the onboarding
// wizard's connect step. Shares all probe/persist logic with the onboarding
// route via connectGraph(), but passes advanceOnboarding:FALSE: a live box must
// not touch onboarding.stage (setEmail would regress it out of 'live'). On a
// live box the default account already has a real email, so createMicrosoftAccount
// inserts a NEW non-default account (multi-account add).
//
// Modes: 'test' runs the Graph token + inbox probe only; 'save' persists ONLY on
// a passing probe (bad creds → 422). The client secret is never echoed back.
export async function POST(req: NextRequest) {
  const b = await parseJson(req, graphConnectBodySchema);
  if (!b.ok) return b.response;
  const { status, body } = await connectGraph(b.data, { advanceOnboarding: false });
  return NextResponse.json(body, { status });
}
