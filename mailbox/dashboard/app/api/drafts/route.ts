import { type NextRequest, NextResponse } from 'next/server';
import { parseQuery } from '@/lib/middleware/validate';
import { getQueueWithUrgency, listDrafts } from '@/lib/queries';
import { listDraftsQuerySchema } from '@/lib/schemas/drafts';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const q = parseQuery(req, listDraftsQuerySchema);
  if (!q.ok) return q.response;

  try {
    // MBOX-162 V3 — urgent=1 routes to the urgency-aware query (filtered to
    // high-priority, enriched with urgency + account); otherwise the plain list.
    const drafts = q.data.urgent
      ? await getQueueWithUrgency(q.data.status, q.data.limit, process.env, true, q.data.account)
      : await listDrafts(q.data.status, q.data.limit, q.data.account);
    return NextResponse.json({ drafts, total: drafts.length });
  } catch (error) {
    console.error('GET /api/drafts failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
