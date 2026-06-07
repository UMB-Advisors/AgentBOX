'use client';

import { Calendar, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl } from '@/lib/api';
import { calendarExternalUrl } from '@/lib/embed';
import { CenteredNotice, ConnectNotice, reasonNotice } from './panel-chrome';

// MBOX-398 + MBOX-415 — Calendar day-view panel with a multi-account picker and
// a per-account calendar toggle. Reads /api/accounts?calendar=1 (which inboxes
// have a calendar grant), /api/calendar/list (the account's calendars), and
// /api/calendar/day (events for the toggled calendars), all account-scoped.

interface DayEvent {
  start: string;
  end: string;
  summary: string;
  calendarId?: string;
}
interface DayResult {
  reason: string;
  date: string;
  events: DayEvent[];
}
interface CalEntry {
  id: string;
  summary: string;
  primary: boolean;
  selected: boolean;
  backgroundColor: string | null;
}
interface AccountOpt {
  id: number;
  email_address: string;
  display_label: string | null;
  is_default: boolean;
  calendar_connected: boolean;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const togglePrefKey = (accountId: number) => `mailbox-cal-toggle-v1:${accountId}`;

function localToday(): string {
  return new Date().toLocaleDateString('en-CA');
}
function shiftDay(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtDateLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? dateStr
    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}
function accountLabel(a: AccountOpt): string {
  return a.display_label || a.email_address;
}

export function CalendarPanel() {
  const [accounts, setAccounts] = useState<AccountOpt[] | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [cals, setCals] = useState<CalEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showCals, setShowCals] = useState(false);
  const [date, setDate] = useState(localToday);
  const [result, setResult] = useState<DayResult | null>(null);
  const [loading, setLoading] = useState(true);

  // 1. Which inboxes have a calendar grant → the account picker options.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/accounts?calendar=1'));
        const data = (await res.json().catch(() => null)) as { accounts?: AccountOpt[] } | null;
        const list = (data?.accounts ?? []).filter((a) => a.calendar_connected);
        if (!alive) return;
        setAccounts(list);
        const def = list.find((a) => a.is_default) ?? list[0];
        setAccountId(def ? def.id : null);
        if (!def) setLoading(false);
      } catch {
        if (alive) {
          setAccounts([]);
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 2. Calendars for the selected account → toggle list + default selection.
  useEffect(() => {
    if (accountId == null) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/calendar/list?account_id=${accountId}`));
        const data = (await res.json().catch(() => null)) as { calendars?: CalEntry[] } | null;
        const list = data?.calendars ?? [];
        if (!alive) return;
        setCals(list);
        let initial: string[] = [];
        try {
          const saved = localStorage.getItem(togglePrefKey(accountId));
          if (saved) initial = JSON.parse(saved) as string[];
        } catch {
          /* ignore */
        }
        if (initial.length === 0) {
          initial = list.filter((c) => c.primary || c.selected).map((c) => c.id);
          if (initial.length === 0 && list.length > 0) initial = [list[0].id];
        }
        setSelected(new Set(initial));
      } catch {
        if (alive) setCals([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [accountId]);

  // 3. Events for the toggled calendars on the chosen day.
  const load = useCallback(async () => {
    if (accountId == null) return;
    setLoading(true);
    const cal = [...selected].join(',');
    try {
      const res = await fetch(
        apiUrl(
          `/api/calendar/day?account_id=${accountId}&date=${date}${cal ? `&cal=${encodeURIComponent(cal)}` : ''}`,
        ),
      );
      const data = (await res.json().catch(() => null)) as DayResult | null;
      setResult(data ?? { reason: 'fetch_failed', date, events: [] });
    } catch {
      setResult({ reason: 'fetch_failed', date, events: [] });
    } finally {
      setLoading(false);
    }
  }, [accountId, date, selected]);

  useEffect(() => {
    void load();
  }, [load]);

  const colorFor = useMemo(() => {
    const m = new Map(cals.map((c) => [c.id, c.backgroundColor]));
    return (id?: string) => (id ? (m.get(id) ?? null) : null);
  }, [cals]);

  function toggleCal(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      if (accountId != null) {
        try {
          localStorage.setItem(togglePrefKey(accountId), JSON.stringify([...next]));
        } catch {
          /* ignore */
        }
      }
      return next;
    });
  }

  if (loading && !result && accounts === null) return <CenteredNotice title="Loading…" />;
  if (accounts !== null && accounts.length === 0) {
    return (
      <ConnectNotice
        icon={<Calendar className="h-8 w-8 text-ink-dim" aria-hidden />}
        label="Calendar"
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar: account picker + day nav */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
        {accounts && accounts.length > 1 && (
          <select
            value={accountId ?? ''}
            onChange={(e) => setAccountId(Number(e.target.value))}
            className="max-w-[7.5rem] truncate rounded-sm border border-border bg-bg-panel px-1 py-0.5 font-mono text-[10px] text-ink"
            aria-label="Calendar account"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {accountLabel(a)}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => setDate(localToday())}
          className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] text-ink-muted hover:text-ink"
        >
          Today
        </button>
        <button
          type="button"
          aria-label="Previous day"
          onClick={() => setDate((d) => shiftDay(d, -1))}
          className="rounded-sm p-1 text-ink-dim hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Next day"
          onClick={() => setDate((d) => shiftDay(d, 1))}
          className="rounded-sm p-1 text-ink-dim hover:text-ink"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
        <span className="ml-0.5 truncate font-mono text-[11px] text-ink">{fmtDateLabel(date)}</span>
        {cals.length > 0 && (
          <button
            type="button"
            onClick={() => setShowCals((v) => !v)}
            aria-pressed={showCals}
            title="Toggle calendars"
            className={`ml-auto rounded-sm px-1.5 py-0.5 font-mono text-[10px] ${showCals ? 'bg-bg-deep text-ink' : 'text-ink-dim hover:text-ink'}`}
          >
            Calendars
          </button>
        )}
        <a
          href={calendarExternalUrl()}
          target="_blank"
          rel="noopener noreferrer"
          title="Open Google Calendar"
          className={`${cals.length > 0 ? '' : 'ml-auto'} rounded-sm p-1 text-ink-dim hover:text-ink`}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      </div>

      {/* Calendar toggle drawer */}
      {showCals && cals.length > 0 && (
        <div className="max-h-40 shrink-0 space-y-0.5 overflow-y-auto border-b border-border-subtle bg-bg-panel/60 p-2">
          {cals.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-center gap-2 px-1 py-0.5 text-xs text-ink"
            >
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => toggleCal(c.id)}
                className="h-3 w-3"
              />
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: c.backgroundColor ?? '#888' }}
                aria-hidden
              />
              <span className="truncate">{c.summary}</span>
            </label>
          ))}
        </div>
      )}

      {loading && !result ? (
        <CenteredNotice title="Loading…" />
      ) : !result || result.reason === 'not_connected' ? (
        <ConnectNotice
          icon={<Calendar className="h-8 w-8 text-ink-dim" aria-hidden />}
          label="Calendar"
        />
      ) : result.reason !== 'ok' ? (
        reasonNotice(result.reason)
      ) : (
        <DayGrid events={result.events} colorFor={colorFor} />
      )}
    </div>
  );
}

function DayGrid({
  events,
  colorFor,
}: {
  events: DayEvent[];
  colorFor: (id?: string) => string | null;
}) {
  const allDay = events.filter((e) => !e.start.includes('T'));
  const timed = events.filter((e) => e.start.includes('T'));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {allDay.length > 0 && (
        <div className="space-y-1 border-b border-border-subtle p-2">
          {allDay.map((e) => (
            <div
              key={`${e.calendarId}-${e.start}-${e.summary}`}
              className="truncate rounded-sm px-2 py-1 text-xs font-medium text-bg-deep"
              style={{
                backgroundColor: colorFor(e.calendarId) ?? 'var(--color-accent-orange, #f2994a)',
              }}
            >
              {e.summary || '(busy)'}
            </div>
          ))}
        </div>
      )}
      <ul>
        {HOURS.map((h) => {
          const inHour = timed.filter((e) => new Date(e.start).getHours() === h);
          return (
            <li
              key={h}
              className="flex min-h-[2.5rem] gap-2 border-b border-border-subtle/50 px-2 py-1"
            >
              <span className="w-12 shrink-0 pt-0.5 text-right font-mono text-[10px] text-ink-dim">
                {hourLabel(h)}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                {inHour.map((e) => {
                  const color = colorFor(e.calendarId);
                  return (
                    <div
                      key={`${e.calendarId}-${e.start}-${e.summary}`}
                      className="rounded-sm border-l-2 bg-bg-panel px-2 py-1"
                      style={{ borderLeftColor: color ?? 'var(--color-accent-green, #27ae60)' }}
                    >
                      <div className="truncate text-xs font-medium text-ink">
                        {e.summary || '(busy)'}
                      </div>
                      <div className="font-mono text-[10px] text-ink-dim">
                        {fmtTime(e.start)}
                        {e.end ? `–${fmtTime(e.end)}` : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
