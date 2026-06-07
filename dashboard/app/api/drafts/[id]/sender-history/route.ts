// dashboard/app/api/drafts/[id]/sender-history/route.ts
//
// STAQPRO-331 #6 — per-counterparty stats for the Sender history panel.
// Resolves the draft id back to its inbound message, then aggregates the
// last 30 days of mail + draft outcomes + reject feedback for that
// sender via lib/queries-sender.ts.
//
// Lookback is configurable via ?days=N (1..365), but clamps to 30 by
// default so the operator-facing latency stays low even on M1's largest
// senders.

import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseParams } from '@/lib/middleware/validate';
import { getSenderHistory } from '@/lib/queries-sender';
import { idParamSchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const daysParam = req.nextUrl.searchParams.get('days');
  const lookbackDays = daysParam ? Number.parseInt(daysParam, 10) : 30;

  try {
    const db = getKysely();
    const draftRow = await db
      .selectFrom('drafts as d')
      .innerJoin('inbox_messages as m', 'd.inbox_message_id', 'm.id')
      .where('d.id', '=', id)
      .select(['m.from_addr'])
      .executeTakeFirst();
    if (!draftRow) {
      return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
    }
    if (!draftRow.from_addr) {
      return NextResponse.json({ history: null, reason: 'no_sender' });
    }

    const history = await getSenderHistory(draftRow.from_addr, lookbackDays);
    if (!history) {
      return NextResponse.json({ history: null, reason: 'no_sender' });
    }
    return NextResponse.json({ history });
  } catch (error) {
    console.error(`GET /api/drafts/${id}/sender-history failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
