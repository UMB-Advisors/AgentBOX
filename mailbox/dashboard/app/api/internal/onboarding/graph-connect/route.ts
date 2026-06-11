import { type NextRequest, NextResponse } from 'next/server';
import { connectGraph } from '@/lib/mail/connect-graph';
import { requireOnboardingToken } from '@/lib/middleware/onboarding-auth';
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
// routes; protected by the shared-secret gate in lib/middleware/onboarding-auth.ts
// when ONBOARDING_API_TOKEN is set (no-op when unset). The client secret is never
// echoed back.
export async function POST(req: NextRequest) {
  const authError = requireOnboardingToken(req);
  if (authError) return authError;

  const b = await parseJson(req, graphConnectBodySchema);
  if (!b.ok) return b.response;
  const { status, body } = await connectGraph(b.data, { advanceOnboarding: true });
  return NextResponse.json(body, { status });
}
