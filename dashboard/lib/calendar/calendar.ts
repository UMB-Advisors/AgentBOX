// dashboard/lib/calendar/calendar.ts
//
// MBOX-130 — read-only Google Calendar pre-read at draft time.
//
// When an inbound classifies as `scheduling` (and CALENDAR_CONTEXT_ENABLED=1),
// the draft route fetches the operator's calendar (now → now+14d) and renders a
// compact `calendar_snapshot` block that gets injected into the draft prompt
// alongside rag_refs (lib/drafting/prompt.ts). The drafter can then propose
// concrete time slots instead of "let me check my calendar and get back to you."
//
// Privacy gate (mirrors RAG cloud-route, STAQPRO-191):
//   - LOCAL route  (Qwen3 on-device) — snapshot ALWAYS passes through.
//   - CLOUD route  — snapshot ONLY passes if CALENDAR_CLOUD_ROUTE_ENABLED=1.
//     Default off → cloud drafts fall back to the no-calendar boilerplate.
//
// Augmentation, not a gate (RAG convention): ANY non-ok reason returns an empty
// snapshot + a reason string. The caller never blocks the draft on a failed
// calendar read — it sets drafts.scheduling_calendar_unavailable and falls back.
//
// No googleapis SDK — direct fetch against the Calendar v3 events endpoint with
// the access token from lib/oauth/google.ts.

import type { DraftSource } from '@/lib/drafting/router';
import { getAccessToken, getConnection, markFetched, OAuthTokenError } from '@/lib/oauth/google';

// Why a calendar read returned no usable snapshot. 'ok' means events were
// fetched (the snapshot may still be empty if the window is genuinely free —
// see `reason: 'no_events'`). Distinct values so the audit surface can tell a
// privacy gate from a token failure from an empty calendar.
export type CalendarReason =
  | 'ok'
  | 'disabled' // CALENDAR_CONTEXT_ENABLED != 1
  | 'cloud_gated' // cloud route + CALENDAR_CLOUD_ROUTE_ENABLED != 1
  | 'not_connected' // no google_calendar oauth token
  | 'token_expired' // refresh token revoked/expired — operator must reconnect
  | 'rate_limited' // Google Calendar API 429
  | 'fetch_failed' // network / 5xx / parse
  | 'no_events'; // fetched cleanly, window is free

export interface CalendarEvent {
  start: string; // ISO
  end: string; // ISO
  summary: string;
  // MBOX-415 — which calendar this event came from (day-view multi-calendar
  // toggle). Unset on the draft-path snapshot, which only reads `primary`.
  calendarId?: string;
}

export interface CalendarSnapshot {
  reason: CalendarReason;
  // Compact rendered lines, e.g. "Mon May 19 14:00-15:00 — STATE 1:1". Empty
  // for any non-ok reason OR a genuinely free window.
  lines: ReadonlyArray<string>;
}

export interface CalendarFetchInput {
  draft_source: DraftSource;
  // Window size in days; defaults to 14 (CALENDAR_LOOKAHEAD_DAYS override).
  lookaheadDays?: number;
  // Injectable clock for tests.
  now?: Date;
}

const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export function isCalendarContextEnabled(): boolean {
  return process.env.CALENDAR_CONTEXT_ENABLED === '1';
}

export function isCalendarCloudRouteEnabled(): boolean {
  return process.env.CALENDAR_CLOUD_ROUTE_ENABLED === '1';
}

function lookaheadDays(input: CalendarFetchInput): number {
  const fromInput = input.lookaheadDays;
  if (typeof fromInput === 'number' && fromInput > 0) return fromInput;
  const fromEnv = Number(process.env.CALENDAR_LOOKAHEAD_DAYS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 14;
}

// ── Per-draft fetch cache (TTL ~30s) ─────────────────────────────────────────
// MBOX-130 — repeated draft assembly within a short window must not hammer the
// Calendar API. Keyed by draft_source so a local and cloud assembly of the same
// inbound don't cross the privacy gate via a shared cache entry.

const CACHE_TTL_MS = Number(process.env.CALENDAR_CACHE_TTL_MS) || 30_000;
interface CacheEntry {
  at: number;
  snapshot: CalendarSnapshot;
}
const cache = new Map<string, CacheEntry>();

export function clearCalendarCache(): void {
  cache.clear();
}

// Compact one-line render: "Mon May 19 14:00-15:00 — <summary>".
// Render in the operator's timezone (GENERIC_TIMEZONE) rather than the Node
// process tz — the mailbox-dashboard container sets no TZ so it defaults to UTC,
// which would show wrong availability and make the LLM propose booked slots.
export function formatEventLine(ev: CalendarEvent): string {
  const start = new Date(ev.start);
  const end = new Date(ev.end);
  if (Number.isNaN(start.getTime())) return '';
  const tz = process.env.GENERIC_TIMEZONE ?? 'UTC';
  const day = start.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  });
  const fmtTime = (d: Date) =>
    Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: tz,
        });
  const range = Number.isNaN(end.getTime()) ? fmtTime(start) : `${fmtTime(start)}-${fmtTime(end)}`;
  const summary = (ev.summary || '(busy)').slice(0, 80);
  return `${day} ${range} — ${summary}`;
}

// Map a raw Google Calendar v3 event into our compact shape, filtered to events
// the operator actually attends. All-day events (date, not dateTime) are kept —
// they still block availability. Cancelled events are dropped.
function coerceEvents(rawItems: unknown, operatorEmail: string | null): CalendarEvent[] {
  if (!Array.isArray(rawItems)) return [];
  const out: CalendarEvent[] = [];
  for (const raw of rawItems) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (o.status === 'cancelled') continue;

    const start = readWhen(o.start);
    const end = readWhen(o.end);
    if (!start) continue;

    // Attendee/organizer filter: keep when the operator is the organizer OR an
    // attendee. When operatorEmail is unknown (account_email not yet resolved),
    // keep everything on the primary calendar — it's the operator's own calendar
    // so the events are theirs by definition.
    if (operatorEmail && !operatorIsInvolved(o, operatorEmail)) continue;

    out.push({
      start,
      end: end ?? start,
      summary: typeof o.summary === 'string' ? o.summary : '(busy)',
    });
  }
  return out;
}

function readWhen(when: unknown): string | null {
  if (typeof when !== 'object' || when === null) return null;
  const w = when as Record<string, unknown>;
  if (typeof w.dateTime === 'string') return w.dateTime;
  if (typeof w.date === 'string') return w.date; // all-day
  return null;
}

function operatorIsInvolved(o: Record<string, unknown>, operatorEmail: string): boolean {
  const lower = operatorEmail.toLowerCase();
  const organizer = o.organizer as Record<string, unknown> | undefined;
  if (typeof organizer?.email === 'string' && organizer.email.toLowerCase() === lower) {
    return true;
  }
  const attendees = o.attendees;
  if (Array.isArray(attendees)) {
    for (const a of attendees) {
      if (
        typeof a === 'object' &&
        a !== null &&
        typeof (a as Record<string, unknown>).email === 'string' &&
        ((a as Record<string, unknown>).email as string).toLowerCase() === lower
      ) {
        return true;
      }
    }
  }
  return false;
}

// Fetch the calendar snapshot for a draft. Never throws — every failure maps to
// a typed reason + empty lines so the draft path can fall back gracefully.
export async function getCalendarSnapshot(input: CalendarFetchInput): Promise<CalendarSnapshot> {
  if (!isCalendarContextEnabled()) {
    return { reason: 'disabled', lines: [] };
  }
  // Privacy gate — cloud route is opt-in.
  if (input.draft_source === 'cloud' && !isCalendarCloudRouteEnabled()) {
    return { reason: 'cloud_gated', lines: [] };
  }

  const cacheKey = input.draft_source;
  const cached = cache.get(cacheKey);
  const nowMs = Date.now();
  if (cached && nowMs - cached.at < CACHE_TTL_MS) {
    return cached.snapshot;
  }

  const snapshot = await fetchSnapshot(input);
  // Only cache terminal outcomes that are cheap-correct to reuse for ~30s.
  // 'rate_limited' and 'fetch_failed' are cached too — re-hammering a failing
  // API inside the TTL window is exactly what the cache exists to prevent.
  cache.set(cacheKey, { at: nowMs, snapshot });
  return snapshot;
}

async function fetchSnapshot(input: CalendarFetchInput): Promise<CalendarSnapshot> {
  const conn = await getConnection('google_calendar');
  if (!conn.connected) {
    return { reason: 'not_connected', lines: [] };
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken('google_calendar');
  } catch (err) {
    if (err instanceof OAuthTokenError) {
      if (err.kind === 'not_connected') return { reason: 'not_connected', lines: [] };
      if (err.kind === 'auth') return { reason: 'token_expired', lines: [] };
      return { reason: 'fetch_failed', lines: [] };
    }
    return { reason: 'fetch_failed', lines: [] };
  }

  const now = input.now ?? new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(
    now.getTime() + lookaheadDays(input) * 24 * 60 * 60 * 1000,
  ).toISOString();
  const url = new URL(CALENDAR_EVENTS_URL);
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '50');

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { reason: 'fetch_failed', lines: [] };
  }

  if (res.status === 429) {
    return { reason: 'rate_limited', lines: [] };
  }
  if (res.status === 401 || res.status === 403) {
    return { reason: 'token_expired', lines: [] };
  }
  if (!res.ok) {
    return { reason: 'fetch_failed', lines: [] };
  }

  const json = (await res.json().catch(() => null)) as { items?: unknown } | null;
  if (!json) {
    return { reason: 'fetch_failed', lines: [] };
  }

  const events = coerceEvents(json.items, conn.account_email);
  // Best-effort stamp; a stamp failure must not fail the fetch.
  void markFetched('google_calendar').catch(() => undefined);

  if (events.length === 0) {
    return { reason: 'no_events', lines: [] };
  }

  const lines = events.map((ev) => formatEventLine(ev)).filter((l) => l.length > 0);
  return { reason: 'ok', lines };
}

// ── MBOX-398 — operator-facing day view (right-rail Calendar panel) ──────────
// Distinct from getCalendarSnapshot above (draft-time, privacy-gated by
// draft_source, 14-day window, rendered to prompt lines). THIS is the operator
// viewing their OWN calendar in their OWN dashboard — no LLM, no cloud egress —
// so there is no draft_source privacy gate. Returns the raw events for a single
// local day (operator's GENERIC_TIMEZONE) for the panel to render on an hour
// grid. Never throws — every failure maps to a typed reason.

export type CalendarDayReason =
  | 'ok'
  | 'not_connected'
  | 'token_expired'
  | 'rate_limited'
  | 'fetch_failed';

export interface CalendarDayResult {
  reason: CalendarDayReason;
  date: string; // YYYY-MM-DD (operator tz) the events belong to
  events: CalendarEvent[];
}

// Format a Date as YYYY-MM-DD in the given IANA tz (en-CA yields ISO order).
function localDateKey(d: Date, tz: string): string {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

// Pure (exported for tests): keep events whose start lands on dateStr in tz,
// sorted ascending by start. All-day events carry a date-only start (no 'T') —
// compared directly; timed events are projected into tz.
export function filterEventsForDay(
  events: CalendarEvent[],
  dateStr: string,
  tz: string,
): CalendarEvent[] {
  return events
    .filter((ev) => {
      if (!ev.start.includes('T')) return ev.start.slice(0, 10) === dateStr;
      const d = new Date(ev.start);
      if (Number.isNaN(d.getTime())) return false;
      return localDateKey(d, tz) === dateStr;
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

export interface GetDayEventsOptions {
  // MBOX-415 — which appliance account's Google grant to read (default account
  // when unset), and which calendars (default ['primary']).
  accountId?: number;
  calendarIds?: string[];
}

async function fetchCalendarWindow(
  calendarId: string,
  accessToken: string,
  timeMin: string,
  timeMax: string,
): Promise<{ ok: boolean; status: number; items: unknown }> {
  const url = new URL(`${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '100');
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return { ok: false, status: res.status, items: null };
    const json = (await res.json().catch(() => null)) as { items?: unknown } | null;
    return { ok: true, status: 200, items: json?.items ?? [] };
  } catch {
    return { ok: false, status: 0, items: null };
  }
}

export async function getDayEvents(
  dateStr: string,
  opts: GetDayEventsOptions = {},
): Promise<CalendarDayResult> {
  const tz = process.env.GENERIC_TIMEZONE ?? 'UTC';
  const conn = await getConnection('google_calendar', opts.accountId);
  if (!conn.connected) return { reason: 'not_connected', date: dateStr, events: [] };

  let accessToken: string;
  try {
    accessToken = await getAccessToken('google_calendar', 5_000, opts.accountId);
  } catch (err) {
    if (err instanceof OAuthTokenError) {
      if (err.kind === 'not_connected')
        return { reason: 'not_connected', date: dateStr, events: [] };
      if (err.kind === 'auth') return { reason: 'token_expired', date: dateStr, events: [] };
    }
    return { reason: 'fetch_failed', date: dateStr, events: [] };
  }

  // Fetch a generous UTC window around the requested local day (±26h covers any
  // tz offset), then filter to the requested day in the operator tz.
  const anchor = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(anchor.getTime())) return { reason: 'fetch_failed', date: dateStr, events: [] };
  const timeMin = new Date(anchor.getTime() - 26 * 3600 * 1000).toISOString();
  const timeMax = new Date(anchor.getTime() + 26 * 3600 * 1000).toISOString();

  const calendarIds =
    opts.calendarIds && opts.calendarIds.length > 0 ? opts.calendarIds : ['primary'];
  const results = await Promise.all(
    calendarIds.map((id) => fetchCalendarWindow(id, accessToken, timeMin, timeMax)),
  );

  // A 401/403 on any calendar → grant bad (reconnect); 429 → rate limited.
  // Otherwise a single bad calendar id is skipped, not fatal.
  if (results.some((r) => r.status === 401 || r.status === 403)) {
    return { reason: 'token_expired', date: dateStr, events: [] };
  }
  if (results.some((r) => r.status === 429)) {
    return { reason: 'rate_limited', date: dateStr, events: [] };
  }
  if (results.every((r) => !r.ok)) {
    return { reason: 'fetch_failed', date: dateStr, events: [] };
  }

  void markFetched('google_calendar', opts.accountId).catch(() => undefined);

  // No attendee filter here (unlike the draft snapshot) — the panel shows
  // everything on the selected calendars, tagged with the source calendarId.
  const merged: CalendarEvent[] = [];
  results.forEach((r, i) => {
    if (!r.ok) return;
    for (const ev of coerceEvents(r.items, null)) {
      merged.push({ ...ev, calendarId: calendarIds[i] });
    }
  });

  return { reason: 'ok', date: dateStr, events: filterEventsForDay(merged, dateStr, tz) };
}

// MBOX-415 — the account's calendar list, for the panel's calendar toggle.
export interface CalendarListEntry {
  id: string;
  summary: string;
  primary: boolean;
  selected: boolean;
  backgroundColor: string | null;
}

export interface CalendarListResult {
  reason: CalendarDayReason;
  calendars: CalendarListEntry[];
}

const CALENDAR_LIST_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';

// Pure (exported for tests): map a calendarList payload → entries, primary first.
export function parseCalendarList(raw: unknown): CalendarListEntry[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const items = (raw as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  const out: CalendarListEntry[] = [];
  for (const it of items) {
    if (typeof it !== 'object' || it === null) continue;
    const o = it as Record<string, unknown>;
    if (typeof o.id !== 'string') continue;
    out.push({
      id: o.id,
      summary: typeof o.summary === 'string' ? o.summary : o.id,
      primary: o.primary === true,
      selected: o.selected === true,
      backgroundColor: typeof o.backgroundColor === 'string' ? o.backgroundColor : null,
    });
  }
  return out.sort((a, b) =>
    a.primary === b.primary ? a.summary.localeCompare(b.summary) : a.primary ? -1 : 1,
  );
}

export async function listCalendars(accountId?: number): Promise<CalendarListResult> {
  const conn = await getConnection('google_calendar', accountId);
  if (!conn.connected) return { reason: 'not_connected', calendars: [] };
  let accessToken: string;
  try {
    accessToken = await getAccessToken('google_calendar', 5_000, accountId);
  } catch (err) {
    if (err instanceof OAuthTokenError) {
      if (err.kind === 'not_connected') return { reason: 'not_connected', calendars: [] };
      if (err.kind === 'auth') return { reason: 'token_expired', calendars: [] };
    }
    return { reason: 'fetch_failed', calendars: [] };
  }
  const url = new URL(CALENDAR_LIST_URL);
  url.searchParams.set('minAccessRole', 'reader');
  url.searchParams.set('maxResults', '250');
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(6_000),
    });
  } catch {
    return { reason: 'fetch_failed', calendars: [] };
  }
  if (res.status === 429) return { reason: 'rate_limited', calendars: [] };
  if (res.status === 401 || res.status === 403) return { reason: 'token_expired', calendars: [] };
  if (!res.ok) return { reason: 'fetch_failed', calendars: [] };
  const json = await res.json().catch(() => null);
  if (!json) return { reason: 'fetch_failed', calendars: [] };
  void markFetched('google_calendar', accountId).catch(() => undefined);
  return { reason: 'ok', calendars: parseCalendarList(json) };
}
