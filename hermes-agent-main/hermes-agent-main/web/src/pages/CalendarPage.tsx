import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { EventDialog, type EventFormSeed } from "@/components/EventDialog";
import { api } from "@/lib/api";
import type { GoogleCalEvent, GoogleCalendarResponse } from "@/lib/api";
import { cn } from "@/lib/utils";
import { usePageHeader } from "@/contexts/usePageHeader";
import { useAccountView } from "@/contexts/useAccountView";

/**
 * Calendar — a Google-Calendar-style view over the operator's connected Google
 * accounts. Month / Week / Day grids with prev/next/Today navigation, an
 * account filter, and click-to-create / click-to-edit backed by the Google
 * Calendar API (`/api/google/calendar` + its `events` CRUD endpoints). When no
 * account is connected the page shows a "Connect Google" prompt.
 */

type ViewMode = "month" | "week" | "day";
const VIEWS: { key: ViewMode; label: string }[] = [
  { key: "month", label: "Month" },
  { key: "week", label: "Week" },
  { key: "day", label: "Day" },
];

const HOUR_HEIGHT = 48; // px per hour in the week/day time grid
const WEEK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PALETTE = [
  "#4285F4",
  "#0B8043",
  "#8E24AA",
  "#E67C73",
  "#F4511E",
  "#039BE5",
  "#7986CB",
  "#33B679",
];

export default function CalendarPage() {
  const { setTitle } = usePageHeader();
  useEffect(() => setTitle("Calendar"), [setTitle]);

  const navigate = useNavigate();
  const { view: accountView } = useAccountView();
  const [view, setView] = useState<ViewMode>("month");
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [data, setData] = useState<GoogleCalendarResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [seed, setSeed] = useState<EventFormSeed | null>(null);

  const range = useMemo(() => rangeFor(view, anchor), [view, anchor]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await api.getGoogleCalendar(accountView, {
          start: range.fetchStart.toISOString(),
          end: range.fetchEnd.toISOString(),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load calendar.");
    } finally {
      setLoading(false);
    }
  }, [accountView, range.fetchStart, range.fetchEnd]);

  useEffect(() => {
    void load();
  }, [load]);

  const connected = data?.connected ?? false;
  const accounts = data?.accounts ?? [];
  const calError = data?.error ?? null;
  const firstLoad = loading && data == null;

  const colorFor = useCallback(
    (account: string) => {
      const i = accounts.indexOf(account);
      return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
    },
    [accounts],
  );

  const events = useMemo(() => parseEvents(data?.events ?? []), [data?.events]);

  const defaultAccount = accountView !== "combined" ? accountView : accounts[0] ?? "";

  const openCreate = useCallback(
    (start: Date, allDay: boolean) => {
      const end = new Date(start.getTime() + (allDay ? 0 : 60 * 60 * 1000));
      setSeed({
        account: defaultAccount,
        title: "",
        allDay,
        startDate: ymd(start),
        startTime: hm(start),
        endDate: ymd(end),
        endTime: hm(end),
        location: "",
        description: "",
      });
      setDialogOpen(true);
    },
    [defaultAccount],
  );

  const openEdit = useCallback((ev: ParsedEvent) => {
    // All-day Google ends are exclusive — show the inclusive last day in the form.
    const endForForm = ev.allDay
      ? new Date(ev.end.getTime() - 24 * 60 * 60 * 1000)
      : ev.end;
    setSeed({
      id: ev.id,
      account: ev.account,
      title: ev.title === "(untitled)" ? "" : ev.title,
      allDay: ev.allDay,
      startDate: ymd(ev.start),
      startTime: hm(ev.start),
      endDate: ymd(endForForm),
      endTime: hm(ev.end),
      location: ev.location,
      description: ev.description,
    });
    setDialogOpen(true);
  }, []);

  const go = (dir: -1 | 0 | 1) => {
    if (dir === 0) {
      setAnchor(startOfDay(new Date()));
      return;
    }
    setAnchor((a) => step(view, a, dir));
  };

  return (
    <div className="mx-auto w-full max-w-6xl">
      <Card className="p-4 sm:p-5">
        {/* Toolbar */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                aria-label="Previous"
                onClick={() => go(-1)}
                disabled={loading || !connected}
                className="grid h-8 w-8 place-items-center rounded-full text-text-secondary transition-colors hover:bg-midground/10 hover:text-foreground disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Next"
                onClick={() => go(1)}
                disabled={loading || !connected}
                className="grid h-8 w-8 place-items-center rounded-full text-text-secondary transition-colors hover:bg-midground/10 hover:text-foreground disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => go(0)}
              disabled={loading || !connected}
              className="rounded-full border border-border px-3 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-midground/5 hover:text-foreground disabled:opacity-40"
            >
              Today
            </button>
            <h2 className="ml-1 text-base font-semibold text-foreground">
              {range.title}
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* View switcher */}
            <div className="flex items-center gap-1">
              {VIEWS.map((v) => {
                const active = view === v.key;
                return (
                  <button
                    key={v.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      if (!active) setView(v.key);
                    }}
                    className={cn(
                      "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                      active
                        ? "bg-brand text-brand-foreground"
                        : "border border-border text-text-secondary hover:bg-midground/5 hover:text-foreground",
                    )}
                  >
                    {v.label}
                  </button>
                );
              })}
            </div>
            <Button
              size="sm"
              disabled={!connected}
              onClick={() => openCreate(defaultCreateStart(view, anchor), false)}
              prefix={<Plus />}
            >
              Create
            </Button>
          </div>
        </div>

        {firstLoad ? (
          <div className="flex items-center gap-2 py-10 text-sm text-text-secondary">
            <Spinner />
            <span>Loading your calendar…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col gap-3 py-6">
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Couldn't load the calendar. {error}</span>
            </div>
            <div>
              <Button type="button" size="sm" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          </div>
        ) : !connected ? (
          <ConnectGoogle onConnect={() => navigate("/settings/google")} />
        ) : (
          <>
            {calError && (
              <p className="mb-3 text-sm text-destructive">{calError}</p>
            )}
            {view === "month" ? (
              <MonthGrid
                anchor={anchor}
                events={events}
                colorFor={colorFor}
                onDayCreate={(d) => openCreate(atHour(d, 9), false)}
                onEventClick={openEdit}
              />
            ) : (
              <TimeGrid
                days={range.days}
                events={events}
                colorFor={colorFor}
                onSlotCreate={(d) => openCreate(d, false)}
                onEventClick={openEdit}
              />
            )}
          </>
        )}
      </Card>

      <EventDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        seed={seed}
        accounts={accounts}
        onSaved={load}
      />
    </div>
  );
}

/* ── Month grid ────────────────────────────────────────────────────────── */

function MonthGrid({
  anchor,
  events,
  colorFor,
  onDayCreate,
  onEventClick,
}: {
  anchor: Date;
  events: ParsedEvent[];
  colorFor: (account: string) => string;
  onDayCreate: (day: Date) => void;
  onEventClick: (ev: ParsedEvent) => void;
}) {
  const gridStart = startOfWeek(startOfMonth(anchor));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const month = anchor.getMonth();
  const todayKey = dayKey(new Date());

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="grid grid-cols-7 border-b border-border bg-midground/5">
        {WEEK_DAYS.map((d) => (
          <div
            key={d}
            className="px-2 py-1.5 text-center text-[11px] font-semibold uppercase tracking-wide text-text-secondary"
          >
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          const inMonth = day.getMonth() === month;
          const isToday = dayKey(day) === todayKey;
          const dayEvents = eventsOnDay(events, day);
          return (
            <div
              key={i}
              onClick={() => onDayCreate(day)}
              className={cn(
                "group min-h-24 cursor-pointer border-b border-r border-border p-1 transition-colors hover:bg-midground/5",
                i % 7 === 6 && "border-r-0",
                i >= 35 && "border-b-0",
                !inMonth && "bg-midground/[0.03]",
              )}
            >
              <div className="mb-1 flex justify-center">
                <span
                  className={cn(
                    "grid h-6 w-6 place-items-center rounded-full text-xs",
                    isToday
                      ? "bg-brand font-semibold text-brand-foreground"
                      : inMonth
                        ? "text-foreground"
                        : "text-text-tertiary",
                  )}
                >
                  {day.getDate()}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                {dayEvents.slice(0, 3).map((ev) => (
                  <button
                    key={ev.id + ev.start.toISOString()}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEventClick(ev);
                    }}
                    title={ev.title}
                    className="flex items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] font-medium text-white"
                    style={{ backgroundColor: colorFor(ev.account) }}
                  >
                    {!ev.allDay && (
                      <span className="shrink-0 opacity-90">
                        {hm12(ev.start)}
                      </span>
                    )}
                    <span className="truncate">{ev.title}</span>
                  </button>
                ))}
                {dayEvents.length > 3 && (
                  <span className="px-1 text-[10px] text-text-secondary">
                    +{dayEvents.length - 3} more
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Week / Day time grid ──────────────────────────────────────────────── */

function TimeGrid({
  days,
  events,
  colorFor,
  onSlotCreate,
  onEventClick,
}: {
  days: Date[];
  events: ParsedEvent[];
  colorFor: (account: string) => string;
  onSlotCreate: (start: Date) => void;
  onEventClick: (ev: ParsedEvent) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Scroll to ~7am on first paint so the working day is visible.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_HEIGHT;
  }, []);

  const todayKey = dayKey(new Date());
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const allDayByDay = days.map((d) => eventsOnDay(events, d).filter((e) => e.allDay));
  const hasAllDay = allDayByDay.some((list) => list.length > 0);

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {/* Day headers */}
      <div
        className="grid border-b border-border bg-midground/5"
        style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, 1fr)` }}
      >
        <div />
        {days.map((d) => {
          const isToday = dayKey(d) === todayKey;
          return (
            <div key={d.toISOString()} className="px-2 py-2 text-center">
              <div className="text-[11px] uppercase tracking-wide text-text-secondary">
                {WEEK_DAYS[(d.getDay() + 6) % 7]}
              </div>
              <div
                className={cn(
                  "mx-auto mt-0.5 grid h-7 w-7 place-items-center rounded-full text-sm",
                  isToday
                    ? "bg-brand font-semibold text-brand-foreground"
                    : "text-foreground",
                )}
              >
                {d.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* All-day band */}
      {hasAllDay && (
        <div
          className="grid border-b border-border"
          style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, 1fr)` }}
        >
          <div className="px-1 py-1 text-right text-[10px] uppercase text-text-tertiary">
            All day
          </div>
          {allDayByDay.map((list, i) => (
            <div
              key={i}
              className="flex flex-col gap-0.5 border-l border-border p-1"
            >
              {list.map((ev) => (
                <button
                  key={ev.id + i}
                  type="button"
                  onClick={() => onEventClick(ev)}
                  title={ev.title}
                  className="truncate rounded px-1 py-0.5 text-left text-[11px] font-medium text-white"
                  style={{ backgroundColor: colorFor(ev.account) }}
                >
                  {ev.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Scrollable hour grid */}
      <div ref={scrollRef} className="max-h-[60vh] overflow-y-auto">
        <div
          className="grid"
          style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, 1fr)` }}
        >
          {/* Hour labels */}
          <div className="relative">
            {hours.map((h) => (
              <div
                key={h}
                className="relative border-b border-transparent text-right"
                style={{ height: HOUR_HEIGHT }}
              >
                <span className="absolute -top-1.5 right-1 text-[10px] text-text-tertiary">
                  {h === 0 ? "" : labelHour(h)}
                </span>
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((day) => {
            const timed = eventsOnDay(events, day).filter((e) => !e.allDay);
            const laid = layoutDay(timed, day);
            return (
              <div key={day.toISOString()} className="relative border-l border-border">
                {hours.map((h) => (
                  <div
                    key={h}
                    onClick={() => onSlotCreate(atHour(day, h))}
                    className="cursor-pointer border-b border-border/60 transition-colors hover:bg-midground/5"
                    style={{ height: HOUR_HEIGHT }}
                  />
                ))}
                {laid.map(({ ev, top, height, left, width }) => (
                  <button
                    key={ev.id + ev.start.toISOString()}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEventClick(ev);
                    }}
                    title={ev.title}
                    className="absolute overflow-hidden rounded px-1 py-0.5 text-left text-[11px] font-medium leading-tight text-white"
                    style={{
                      top,
                      height: Math.max(height, 14),
                      left: `calc(${left * 100}% + 2px)`,
                      width: `calc(${width * 100}% - 4px)`,
                      backgroundColor: colorFor(ev.account),
                    }}
                  >
                    <span className="block truncate font-semibold">{ev.title}</span>
                    {height > 28 && (
                      <span className="block truncate opacity-90">
                        {hm12(ev.start)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── Connect prompt ────────────────────────────────────────────────────── */

function ConnectGoogle({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-6">
      <p className="text-sm font-medium text-foreground">
        Connect Google to see your calendar
      </p>
      <p className="text-sm text-text-secondary">
        Your calendar reads and writes events on your Google Calendar.
      </p>
      <Button size="sm" onClick={onConnect}>
        Connect Google accounts
      </Button>
    </div>
  );
}

/* ── Parsed events + day layout ────────────────────────────────────────── */

interface ParsedEvent {
  id: string;
  account: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string;
  description: string;
  link: string;
}

function parseEvents(raw: GoogleCalEvent[]): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  for (const ev of raw) {
    const start = parseStart(ev);
    if (!start) continue;
    const end = parseEnd(ev, start);
    out.push({
      id: ev.id || `${ev.account}-${ev.start}`,
      account: ev.account,
      title: ev.title || "(no title)",
      start,
      end,
      allDay: ev.all_day,
      location: ev.location,
      description: ev.description,
      link: ev.link,
    });
  }
  return out;
}

function parseStart(ev: GoogleCalEvent): Date | null {
  if (!ev.start) return null;
  if (ev.all_day) {
    const [y, m, d] = ev.start.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }
  const d = new Date(ev.start);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseEnd(ev: GoogleCalEvent, start: Date): Date {
  if (ev.all_day) {
    if (ev.end) {
      const [y, m, d] = ev.end.split("-").map(Number);
      if (y && m && d) return new Date(y, m - 1, d); // exclusive end
    }
    return addDays(start, 1);
  }
  const d = ev.end ? new Date(ev.end) : start;
  return Number.isNaN(d.getTime()) ? new Date(start.getTime() + 3600000) : d;
}

/** Events overlapping a given calendar day, in start order. */
function eventsOnDay(events: ParsedEvent[], day: Date): ParsedEvent[] {
  const ds = startOfDay(day).getTime();
  const de = ds + 24 * 60 * 60 * 1000;
  return events
    .filter((e) => e.start.getTime() < de && e.end.getTime() > ds)
    .sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return a.start.getTime() - b.start.getTime();
    });
}

interface LaidEvent {
  ev: ParsedEvent;
  top: number;
  height: number;
  left: number;
  width: number;
}

/** Position timed events within one day column, splitting overlapping events
 *  into side-by-side columns (a simplified version of Google's overlap layout). */
function layoutDay(timed: ParsedEvent[], day: Date): LaidEvent[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const px = (t: number) =>
    ((Math.min(Math.max(t, dayStart), dayEnd) - dayStart) / 3600000) * HOUR_HEIGHT;

  const items = timed
    .map((ev) => ({
      ev,
      s: Math.max(ev.start.getTime(), dayStart),
      e: Math.min(ev.end.getTime(), dayEnd),
    }))
    .sort((a, b) => a.s - b.s || a.e - b.e);

  // Greedy column assignment within clusters of mutually-overlapping events.
  const out: LaidEvent[] = [];
  let cluster: typeof items = [];
  const flush = () => {
    if (!cluster.length) return;
    const cols: number[] = []; // end time per column
    const assigned: { item: (typeof items)[0]; col: number }[] = [];
    for (const it of cluster) {
      let col = cols.findIndex((end) => end <= it.s);
      if (col === -1) {
        col = cols.length;
        cols.push(it.e);
      } else {
        cols[col] = it.e;
      }
      assigned.push({ item: it, col });
    }
    const n = cols.length;
    for (const { item, col } of assigned) {
      out.push({
        ev: item.ev,
        top: px(item.s),
        height: px(item.e) - px(item.s),
        left: col / n,
        width: 1 / n,
      });
    }
    cluster = [];
  };
  let clusterEnd = -Infinity;
  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  flush();
  return out;
}

/* ── Date helpers (plain Date, Monday-first weeks) ─────────────────────── */

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  const dow = (s.getDay() + 6) % 7; // 0 = Monday
  return addDays(s, -dow);
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function atHour(d: Date, h: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 0, 0);
}
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function hm(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function hm12(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function labelHour(h: number): string {
  const ampm = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour} ${ampm}`;
}

/** Visible window + fetch window + title for a view at an anchor date. The
 *  fetch window pads to whole grid weeks (month) so edge events still show. */
function rangeFor(
  view: ViewMode,
  anchor: Date,
): { days: Date[]; fetchStart: Date; fetchEnd: Date; title: string } {
  if (view === "day") {
    const d = startOfDay(anchor);
    return {
      days: [d],
      fetchStart: d,
      fetchEnd: addDays(d, 1),
      title: d.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    };
  }
  if (view === "week") {
    const s = startOfWeek(anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(s, i));
    const end = addDays(s, 6);
    const sameMonth = s.getMonth() === end.getMonth();
    const title = sameMonth
      ? `${s.toLocaleDateString(undefined, { month: "long" })} ${s.getDate()}–${end.getDate()}, ${end.getFullYear()}`
      : `${s.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${end.getFullYear()}`;
    return { days, fetchStart: s, fetchEnd: addDays(s, 7), title };
  }
  // month
  const gridStart = startOfWeek(startOfMonth(anchor));
  return {
    days: [],
    fetchStart: gridStart,
    fetchEnd: addDays(gridStart, 42),
    title: anchor.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    }),
  };
}

function step(view: ViewMode, anchor: Date, dir: -1 | 1): Date {
  if (view === "day") return addDays(anchor, dir);
  if (view === "week") return addDays(anchor, 7 * dir);
  return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
}

/** Sensible default start time for the "Create" button per view. */
function defaultCreateStart(view: ViewMode, anchor: Date): Date {
  if (view === "month") return atHour(new Date(), 9);
  return atHour(view === "day" ? anchor : new Date(), 9);
}
