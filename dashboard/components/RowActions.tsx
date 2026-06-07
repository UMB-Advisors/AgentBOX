'use client';

import { Archive, Clock, MailOpen, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

// MBOX-369 — Gmail-style per-row hover actions: archive, snooze, mark-read,
// delete. Presentational only — the parent (QueueClient) owns the API calls and
// optimistic list updates. Snooze resolves its preset to an ABSOLUTE instant in
// the operator's browser timezone and hands back an ISO string (the server does
// no tz math). Delete uses a 5s arm-then-confirm window, matching StuckApproved
// / the Gmail-cooldown Force-resume affordance, since trashing is destructive.

const ARM_MS = 5000;

interface SnoozePreset {
  label: string;
  until: () => Date;
}

const SNOOZE_PRESETS: SnoozePreset[] = [
  { label: 'In 1 hour', until: () => new Date(Date.now() + 60 * 60 * 1000) },
  { label: 'In 3 hours', until: () => new Date(Date.now() + 3 * 60 * 60 * 1000) },
  {
    label: 'Tomorrow, 8 AM',
    until: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(8, 0, 0, 0);
      return d;
    },
  },
];

const ICON_BTN =
  'flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-bg-deep hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent';

export function RowActions({
  isRead,
  busy = false,
  onArchive,
  onDelete,
  onMarkRead,
  onSnooze,
}: {
  isRead: boolean;
  busy?: boolean;
  onArchive: () => void;
  onDelete: () => void;
  onMarkRead: () => void;
  onSnooze: (untilISO: string) => void;
}) {
  const [armed, setArmed] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    };
  }, []);

  // Stop the row's onSelect from firing when an action icon is clicked.
  function swallow(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleDelete(e: React.MouseEvent) {
    swallow(e);
    if (busy) return;
    if (!armed) {
      setArmed(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), ARM_MS);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(false);
    onDelete();
  }

  function chooseSnooze(until: Date, e: React.MouseEvent) {
    swallow(e);
    if (until.getTime() <= Date.now()) return;
    onSnooze(until.toISOString());
    setSnoozeOpen(false);
    setCustomOpen(false);
  }

  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border bg-bg-panel/95 px-1 py-0.5 shadow-sm backdrop-blur">
      <button
        type="button"
        title="Archive"
        aria-label="Archive"
        className={ICON_BTN}
        disabled={busy}
        onClick={(e) => {
          swallow(e);
          if (!busy) onArchive();
        }}
      >
        <Archive className="h-4 w-4" />
      </button>

      {/* Snooze — opens a small preset menu. */}
      <div className="relative">
        <button
          type="button"
          title="Snooze"
          aria-label="Snooze"
          aria-expanded={snoozeOpen}
          className={ICON_BTN}
          disabled={busy}
          onClick={(e) => {
            swallow(e);
            if (!busy) setSnoozeOpen((v) => !v);
          }}
        >
          <Clock className="h-4 w-4" />
        </button>
        {snoozeOpen && (
          <div
            className="absolute right-0 top-8 z-20 w-44 rounded-md border border-border bg-bg-panel py-1 text-left shadow-lg"
            onClick={swallow}
            onKeyDown={(e) => e.stopPropagation()}
            role="menu"
          >
            {SNOOZE_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                role="menuitem"
                className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-bg-deep"
                onClick={(e) => chooseSnooze(p.until(), e)}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left text-xs text-ink-muted hover:bg-bg-deep"
              onClick={(e) => {
                swallow(e);
                setCustomOpen((v) => !v);
              }}
            >
              Custom…
            </button>
            {customOpen && (
              <div className="border-t border-border-subtle px-2 pt-2 pb-1">
                <input
                  type="datetime-local"
                  value={customValue}
                  onChange={(e) => setCustomValue(e.target.value)}
                  onClick={swallow}
                  className="w-full rounded border border-border bg-bg-deep px-1.5 py-1 text-xs text-ink"
                />
                <button
                  type="button"
                  className="mt-1 w-full rounded bg-accent-orange/20 px-2 py-1 text-xs text-accent-orange hover:bg-accent-orange/30 disabled:opacity-40"
                  disabled={!customValue}
                  onClick={(e) => {
                    if (!customValue) return swallow(e);
                    chooseSnooze(new Date(customValue), e);
                  }}
                >
                  Snooze until
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Mark read — only meaningful while unread. */}
      <button
        type="button"
        title={isRead ? 'Already read' : 'Mark as read'}
        aria-label="Mark as read"
        className={ICON_BTN}
        disabled={busy || isRead}
        onClick={(e) => {
          swallow(e);
          if (!busy && !isRead) onMarkRead();
        }}
      >
        <MailOpen className="h-4 w-4" />
      </button>

      {/* Delete — 5s arm-then-confirm. */}
      <button
        type="button"
        title={armed ? 'Click again to delete' : 'Delete (move to Trash)'}
        aria-label="Delete"
        className={`${ICON_BTN} ${armed ? 'bg-accent-red/15 text-accent-red hover:bg-accent-red/25 hover:text-accent-red' : 'hover:text-accent-red'}`}
        disabled={busy}
        onClick={handleDelete}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
