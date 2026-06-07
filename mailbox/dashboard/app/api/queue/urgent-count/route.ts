import { NextResponse } from 'next/server';
import { countUrgentDrafts } from '@/lib/queries';

// MBOX-134 — red-flag count for the dashboard header.
//
// GET /api/queue/urgent-count → { count: number }
//
// Counts queue-slice drafts (pending + edited) that fire at least one urgency
// signal (escalate | vip | aged | low_conf — see lib/urgency.ts). Computed
// entirely in SQL (countUrgentDrafts), so this is a single COUNT, not an N+1
// of per-row evaluator calls.

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const count = await countUrgentDrafts();
    return NextResponse.json({ count });
  } catch (error) {
    console.error('GET /api/queue/urgent-count failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
