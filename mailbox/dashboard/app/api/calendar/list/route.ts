import { type NextRequest, NextResponse } from 'next/server';
import { listCalendars } from '@/lib/calendar/calendar';

export const dynamic = 'force-dynamic';

// MBOX-415 — the connected account's calendar list, backing the panel's
// calendar toggle. GET /api/calendar/list?account_id=N (default account when
// unset). Caddy basic_auth gated; never 500s.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const n = Number(req.nextUrl.searchParams.get('account_id'));
  const accountId = Number.isInteger(n) && n > 0 ? n : undefined;
  try {
    return NextResponse.json(await listCalendars(accountId));
  } catch (error) {
    console.error('GET /api/calendar/list failed:', error);
    return NextResponse.json({ reason: 'fetch_failed', calendars: [] });
  }
}
