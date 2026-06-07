// dashboard/lib/calendar/events.ts
//
// MBOX-460 v2 — create/update a Google Calendar event for a `scheduling` draft.
// The write counterpart to the MBOX-130 read-only pre-read (calendar.ts): the
// operator composes an event (time + attendees) in the queue's right pane and
// the box writes it to their primary calendar on the `calendar.events` scope
// (the MBOX-460 scope upgrade). Operator-gated UX-side; this module just writes.
//
// Idempotency WITHOUT a DB column: the event id is DERIVED from the draft id
// (`eventIdForDraft`), so re-submitting targets the SAME event. We try insert;
// a 409 (already exists for this draft) falls back to update (PUT) — giving
// create-or-edit semantics keyed on the draft, so an operator who changes the
// time/attendees and re-submits updates the one event instead of duplicating.
//
// No googleapis SDK — direct fetch against Calendar v3, same style as calendar.ts.

import { getAccessToken, OAuthTokenError } from '@/lib/oauth/google';

const CALENDAR_EVENTS_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

// Distinct reasons so the route can map to the right HTTP status and the
// composer can show an actionable message. `needs_reconsent` is the post-scope-
// upgrade case: a calendar.readonly grant can read but not write.
export type CreateEventReason =
  | 'ok'
  | 'not_connected'
  | 'needs_reconsent'
  | 'invalid_time'
  | 'rate_limited'
  | 'fetch_failed';

export interface CreateEventInput {
  draftId: number;
  accountId?: number;
  summary: string;
  description?: string;
  startISO: string; // RFC3339 (carries offset/Z — the browser composes it)
  endISO: string;
  timeZone?: string;
  attendees?: string[]; // bare email addresses
  status?: 'tentative' | 'confirmed';
  sendUpdates?: 'all' | 'none'; // 'all' emails attendees an invite
}

export interface CreateEventResult {
  reason: CreateEventReason;
  eventId?: string;
  htmlLink?: string;
  created?: boolean; // true = inserted, false = updated an existing event
}

// Deterministic, VALID Google event id from a draft id. Google event ids accept
// base32hex characters (digits 0-9 and letters a-v); `Number.toString(32)` emits
// exactly those, and the 'mb' prefix stays within a-v. Pad so it always clears
// the 5-character minimum. Same draft → same id → idempotent writes.
export function eventIdForDraft(draftId: number): string {
  return `mb${draftId.toString(32).padStart(6, '0')}`;
}

// Pure: assemble the Calendar v3 event resource. Exported for tests.
export function buildEventResource(input: CreateEventInput, tz: string) {
  const attendees = (input.attendees ?? [])
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0)
    .map((email) => ({ email }));
  return {
    id: eventIdForDraft(input.draftId),
    summary: input.summary,
    ...(input.description ? { description: input.description } : {}),
    status: input.status ?? 'tentative',
    start: { dateTime: input.startISO, timeZone: tz },
    end: { dateTime: input.endISO, timeZone: tz },
    ...(attendees.length > 0 ? { attendees } : {}),
  };
}

// Map a non-ok Google HTTP status to a typed reason. 401/403 on the write path
// after the scope upgrade almost always means the grant is still calendar.readonly
// → surface as needs_reconsent so the composer points at the reconnect flow.
function reasonFromStatus(status: number): CreateEventReason {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'needs_reconsent';
  return 'fetch_failed';
}

export async function createOrUpdateCalendarEvent(
  input: CreateEventInput,
): Promise<CreateEventResult> {
  const start = Date.parse(input.startISO);
  const end = Date.parse(input.endISO);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { reason: 'invalid_time' };
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken('google_calendar', 6_000, input.accountId);
  } catch (err) {
    if (err instanceof OAuthTokenError) {
      if (err.kind === 'not_connected') return { reason: 'not_connected' };
      // 'auth' = stale scope (calendar.readonly) or revoked refresh token; both
      // are fixed by reconnecting, which re-grants calendar.events.
      if (err.kind === 'auth') return { reason: 'needs_reconsent' };
      return { reason: 'fetch_failed' };
    }
    return { reason: 'fetch_failed' };
  }

  const tz = input.timeZone ?? process.env.GENERIC_TIMEZONE ?? 'UTC';
  const resource = buildEventResource(input, tz);
  const sendUpdates = input.sendUpdates ?? 'none';
  const eventId = resource.id;

  // Insert first (create). 409 → the event already exists for this draft → PUT
  // update with the new resource (operator changed time/attendees).
  const insertUrl = new URL(CALENDAR_EVENTS_BASE);
  insertUrl.searchParams.set('sendUpdates', sendUpdates);

  let res: Response;
  try {
    res = await fetch(insertUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(resource),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { reason: 'fetch_failed' };
  }

  if (res.status === 409) {
    const updateUrl = new URL(`${CALENDAR_EVENTS_BASE}/${encodeURIComponent(eventId)}`);
    updateUrl.searchParams.set('sendUpdates', sendUpdates);
    try {
      res = await fetch(updateUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(resource),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      return { reason: 'fetch_failed' };
    }
    if (!res.ok) return { reason: reasonFromStatus(res.status) };
    const json = (await res.json().catch(() => null)) as { id?: string; htmlLink?: string } | null;
    return { reason: 'ok', eventId: json?.id ?? eventId, htmlLink: json?.htmlLink, created: false };
  }

  if (!res.ok) return { reason: reasonFromStatus(res.status) };
  const json = (await res.json().catch(() => null)) as { id?: string; htmlLink?: string } | null;
  return { reason: 'ok', eventId: json?.id ?? eventId, htmlLink: json?.htmlLink, created: true };
}
