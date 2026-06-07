import type { NextRequest } from 'next/server';
import { parseParams } from '@/lib/middleware/validate';
import { idParamSchema } from '@/lib/schemas/common';
import { transitionToApprovedAndSend } from '@/lib/transitions';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;

  // STAQPRO-202 — 'failed' dropped from fromStates after migration 016
  // retired the status. Send-side errors now leave the row at 'approved';
  // the retry route handles operator-driven recovery.
  //
  // Audit 2026-05-15 (Linus L3): clearError flipped from false → true.
  // STAQPRO-271 makes `drafts.error_message` carry send-failure forensics
  // surfaced by StuckApproved. A re-approval is always a fresh send
  // attempt — leaving the prior failure's error_message in place would
  // render stale text as if it were a live failure. The retry route
  // already does this; the approve route now matches.
  return transitionToApprovedAndSend(p.data.id, {
    fromStates: ['pending', 'edited'],
    fromStatesLabel: 'pending or edited',
    clearError: true,
    routeName: 'approve',
  });
}
