'use client';

import { Calendar, Check, ExternalLink } from 'lucide-react';
import { useMemo, useState } from 'react';
import { apiUrl } from '@/lib/api';
import { extractAddress } from '@/lib/classification/preclass';
import type { DraftWithMessage } from '@/lib/types';

// MBOX-460 v2 — compose + create a Google Calendar event for a scheduling draft.
// Lives in the right-side detail pane, only for scheduling drafts. Prefills the
// title from the subject and the attendee from the message sender; the operator
// sets the start + duration and optionally toggles emailing the invite. POSTs to
// /api/drafts/[id]/calendar-event, which is idempotent per draft — re-submitting
// after an edit updates the same event rather than duplicating it. Decoupled from
// approve/send by design (a calendar write failing must not block the reply).

const DURATIONS = [15, 30, 45, 60, 90] as const;

// Next top-of-hour in the browser's local wall clock, formatted for
// <input type="datetime-local"> (YYYY-MM-DDTHH:mm). Date is fine in client code.
function defaultStartLocal(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Result =
  | { kind: 'ok'; htmlLink: string | null; created: boolean }
  | { kind: 'error'; reason: string };

const ERROR_TEXT: Record<string, string> = {
  needs_reconsent:
    'Reconnect Google Calendar (Settings → Integrations) — the grant can’t write events yet.',
  not_connected: 'Connect Google Calendar in Settings → Integrations first.',
  invalid_time: 'Pick a valid start time.',
  rate_limited: 'Google rate-limited the calendar — try again shortly.',
};

export function CalendarEventComposer({ draft }: { draft: DraftWithMessage }) {
  const m = draft.message;
  const senderEmail = useMemo(() => extractAddress(m.from_addr ?? undefined), [m.from_addr]);

  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(m.subject?.trim() || 'Meeting');
  const [startLocal, setStartLocal] = useState(defaultStartLocal);
  const [duration, setDuration] = useState<number>(30);
  const [attendees, setAttendees] = useState(senderEmail || '');
  const [status, setStatus] = useState<'tentative' | 'confirmed'>('tentative');
  const [sendInvite, setSendInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function submit() {
    setBusy(true);
    setResult(null);
    try {
      const startMs = new Date(startLocal).getTime();
      if (!Number.isFinite(startMs)) {
        setResult({ kind: 'error', reason: 'invalid_time' });
        return;
      }
      const start = new Date(startMs).toISOString();
      const end = new Date(startMs + duration * 60_000).toISOString();
      const list = attendees
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter((s) => s.includes('@'));
      const acct = draft.account?.id;
      const q = acct != null ? `?account_id=${acct}` : '';
      const res = await fetch(apiUrl(`/api/drafts/${draft.id}/calendar-event${q}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary,
          start,
          end,
          attendees: list,
          status,
          send_invite: sendInvite,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setResult({ kind: 'error', reason: data?.reason ?? `failed_${res.status}` });
        return;
      }
      setResult({ kind: 'ok', htmlLink: data.html_link ?? null, created: data.created });
    } catch {
      setResult({ kind: 'error', reason: 'network' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-sm border border-border bg-bg-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Calendar size={14} className="shrink-0 text-accent-blue" aria-hidden />
        <span className="font-mono text-xs uppercase tracking-wide text-ink">Add to calendar</span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-ink-dim">
          {open ? 'Hide' : 'Compose'}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wide text-ink-dim">
              Title
            </span>
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              className="rounded-sm border border-border bg-bg-deep px-2 py-1 font-sans text-sm text-ink"
            />
          </label>

          <div className="flex gap-2">
            <label className="flex flex-1 flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-ink-dim">
                Start
              </span>
              <input
                type="datetime-local"
                value={startLocal}
                onChange={(e) => setStartLocal(e.target.value)}
                className="rounded-sm border border-border bg-bg-deep px-2 py-1 font-mono text-xs text-ink"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-ink-dim">
                Length
              </span>
              <select
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="rounded-sm border border-border bg-bg-deep px-2 py-1 font-mono text-xs text-ink"
              >
                {DURATIONS.map((d) => (
                  <option key={d} value={d}>
                    {d} min
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wide text-ink-dim">
              Attendees (comma-separated)
            </span>
            <input
              value={attendees}
              onChange={(e) => setAttendees(e.target.value)}
              placeholder="name@example.com"
              className="rounded-sm border border-border bg-bg-deep px-2 py-1 font-mono text-xs text-ink"
            />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wide text-ink-dim">
                Hold
              </span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as 'tentative' | 'confirmed')}
                className="rounded-sm border border-border bg-bg-deep px-2 py-1 font-mono text-xs text-ink"
              >
                <option value="tentative">Tentative</option>
                <option value="confirmed">Confirmed</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 font-sans text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={sendInvite}
                onChange={(e) => setSendInvite(e.target.checked)}
              />
              Email invite to attendees
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={busy || summary.trim().length === 0}
              className="inline-flex items-center gap-1 rounded-sm border border-accent-blue/50 bg-accent-blue/10 px-3 py-1.5 font-sans text-xs text-accent-blue transition-colors hover:bg-accent-blue/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Calendar size={13} /> {busy ? 'Saving…' : 'Create / update event'}
            </button>
            {result?.kind === 'ok' && (
              <span className="inline-flex items-center gap-1 font-sans text-xs text-accent-green">
                <Check size={13} /> {result.created ? 'Event created' : 'Event updated'}
                {result.htmlLink && (
                  <a
                    href={result.htmlLink}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-accent-blue underline"
                  >
                    open <ExternalLink size={11} />
                  </a>
                )}
              </span>
            )}
            {result?.kind === 'error' && (
              <span className="font-sans text-xs text-accent-red">
                {ERROR_TEXT[result.reason] ?? `Couldn’t save event (${result.reason}).`}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
