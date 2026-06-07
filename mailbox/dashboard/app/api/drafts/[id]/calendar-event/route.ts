import { type NextRequest, NextResponse } from 'next/server';
import { createOrUpdateCalendarEvent } from '@/lib/calendar/events';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { calendarEventBodySchema } from '@/lib/schemas/calendar-event';
import { idParamSchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

// MBOX-460 v2 — create/update the Google Calendar event the operator composed
// for a scheduling draft (basic_auth gated by Caddy; operator-facing CRUD).
//
// Deliberately DECOUPLED from approve/send: a calendar write failing must not
// block the reply, and a send failing must not orphan an event. The write is
// idempotent per draft via the derived event id (lib/calendar/events.ts), so the
// operator can re-submit after editing the time/attendees without duplicating.
// Reads ?account_id like the sibling Google routes (MBOX-415 multi-account).

function accountIdFromQuery(req: NextRequest): number | undefined {
  const raw = req.nextUrl.searchParams.get('account_id');
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const b = await parseJson(req, calendarEventBodySchema);
  if (!b.ok) return b.response;

  const result = await createOrUpdateCalendarEvent({
    draftId: p.data.id,
    accountId: accountIdFromQuery(req),
    summary: b.data.summary,
    description: b.data.description,
    startISO: b.data.start,
    endISO: b.data.end,
    attendees: b.data.attendees,
    status: b.data.status,
    sendUpdates: b.data.send_invite ? 'all' : 'none',
  });

  if (result.reason !== 'ok') {
    // not_connected / needs_reconsent → 409 (operator must (re)connect Calendar
    // in Settings → Integrations); invalid_time → 400; rate_limited → 429; the
    // rest are upstream failures → 502.
    const status =
      result.reason === 'not_connected' || result.reason === 'needs_reconsent'
        ? 409
        : result.reason === 'invalid_time'
          ? 400
          : result.reason === 'rate_limited'
            ? 429
            : 502;
    return NextResponse.json({ ok: false, reason: result.reason }, { status });
  }

  return NextResponse.json({
    ok: true,
    event_id: result.eventId,
    html_link: result.htmlLink ?? null,
    created: result.created ?? true,
  });
}
