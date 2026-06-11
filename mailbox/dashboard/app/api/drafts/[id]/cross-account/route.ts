// dashboard/app/api/drafts/[id]/cross-account/route.ts
//
// MBOX-367 (MBOX-162 V4) — cross-account intelligence. Resolves the draft to
// its inbound sender + owning account, then returns the OTHER inboxes that same
// counterparty has reached ("also emailed your founder address last week").
//
// Short-circuits to an empty list on a single-account appliance (there are no
// other inboxes to correlate) so the common case costs one tiny accounts COUNT
// — no scan of inbox_messages. Lookback configurable via ?days=N (1..365),
// default 90 (cross-account recall is a long-memory signal).

import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseParams } from '@/lib/middleware/validate';
import { listAccounts } from '@/lib/queries-accounts';
import { type CrossAccountSenderRow, getSenderAcrossAccounts } from '@/lib/queries-sender';
import { idParamSchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const daysParam = req.nextUrl.searchParams.get('days');
  const lookbackDays = daysParam ? Number.parseInt(daysParam, 10) : 90;

  try {
    // Single-account boxes can never have cross-account history — skip the
    // sender scan entirely. (accounts is a tiny table.)
    const accounts = await listAccounts();
    if (accounts.length <= 1) {
      return NextResponse.json({ rows: [] as CrossAccountSenderRow[] });
    }

    const db = getKysely();
    const draftRow = await db
      .selectFrom('drafts as d')
      .innerJoin('inbox_messages as m', 'd.inbox_message_id', 'm.id')
      .where('d.id', '=', id)
      .select(['m.from_addr', 'd.account_id'])
      .executeTakeFirst();
    if (!draftRow) {
      return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
    }
    if (!draftRow.from_addr) {
      return NextResponse.json({ rows: [] as CrossAccountSenderRow[], reason: 'no_sender' });
    }

    const rows = await getSenderAcrossAccounts(
      draftRow.from_addr,
      draftRow.account_id,
      lookbackDays,
    );
    return NextResponse.json({ rows });
  } catch (error) {
    console.error(`GET /api/drafts/${id}/cross-account failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
