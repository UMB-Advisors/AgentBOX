import { NextResponse } from 'next/server';
import { getOnboarding } from '@/lib/queries-onboarding';

export const dynamic = 'force-dynamic';

// D-49 — classification fires unconditionally; drafting is gated until
// onboarding reaches 'live'. The n8n classify sub-workflow calls this before
// inserting a drafts row. Returns {live: boolean, stage: string} so the
// workflow logs "why drafting was skipped" alongside the gate decision.
//
// Stub variant for 02-04a: read-only against mailbox.onboarding which 02-02-v2
// already seeded with stage='pending_admin'. Once 02-08 ships the onboarding
// wizard the operator can advance through stages; until then drafts only flow
// when stage is manually set to 'live' for dogfood testing.
export async function GET() {
  try {
    const row = await getOnboarding();
    const stage = row?.stage ?? 'pending_admin';
    const bypass = process.env.MAILBOX_LIVE_GATE_BYPASS === '1';
    const live = bypass || stage === 'live';
    return NextResponse.json({ live, stage, bypass });
  } catch (error) {
    console.error('GET /api/onboarding/live-gate failed:', error);
    // Fail closed — never accidentally allow drafting because the gate errored.
    return NextResponse.json(
      {
        live: false,
        stage: 'error',
        bypass: false,
        error: error instanceof Error ? error.message : 'Internal error',
      },
      { status: 500 },
    );
  }
}
