import { type NextRequest, NextResponse } from 'next/server';
import { getDayEvents } from '@/lib/calendar/calendar';

export const dynamic = 'force-dynamic';

// MBOX-398 + MBOX-415 — operator-facing day view for the right-rail Calendar
// panel. GET /api/calendar/day?date=YYYY-MM-DD&account_id=N&cal=id1,id2
//   date       defaults to today in GENERIC_TIMEZONE
//   account_id defaults to the default appliance account
//   cal        comma-separated calendar ids; defaults to ['primary']
// Caddy basic_auth gated. Never 500s — returns the typed reason.

function intParam(v: string | null): number | undefined {
  const n = v ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sp = req.nextUrl.searchParams;
  const tz = process.env.GENERIC_TIMEZONE ?? 'UTC';
  const raw = sp.get('date');
  const date =
    raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? raw
      : new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const accountId = intParam(sp.get('account_id'));
  const calParam = sp.get('cal');
  const calendarIds = calParam
    ? calParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  try {
    return NextResponse.json(await getDayEvents(date, { accountId, calendarIds }));
  } catch (error) {
    console.error('GET /api/calendar/day failed:', error);
    return NextResponse.json({ reason: 'fetch_failed', date, events: [] });
  }
}
