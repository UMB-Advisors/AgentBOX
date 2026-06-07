'use client';

import { Calendar, FolderOpen, ListChecks, type LucideIcon, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CalendarPanel } from './right-pane/CalendarPanel';
import { ContactsPanel } from './right-pane/ContactsPanel';
import { DrivePanel } from './right-pane/DrivePanel';
import { TasksPanel } from './right-pane/TasksPanel';

// MBOX-398 — the queue's right pane, reworked into a Gmail-style side panel:
// a far-right vertical icon RAIL whose buttons select an openable panel
// (Calendar day-view, Contacts, Tasks, Drive). Replaces the prior tab-strip +
// iframe-only P4 stub. The panels render NATIVE data over the Google OAuth
// grants (lib/calendar, lib/contacts, lib/tasks) — Drive stays an iframe embed.
//
// The open/closed toggle + the surrounding PanelGroup panel still live in
// QueueClient; this component owns the rail + the active-panel surface. Props
// are unchanged (calendarSrc kept for QueueClient's contract; the native
// Calendar panel reads the OAuth grant rather than an embed src).

type PanelKey = 'calendar' | 'contacts' | 'tasks' | 'drive';
const PANEL_PREF_KEY = 'mailbox-queue-right-panel-v2';

const PANELS: Array<{ key: PanelKey; label: string; Icon: LucideIcon }> = [
  { key: 'calendar', label: 'Calendar', Icon: Calendar },
  { key: 'contacts', label: 'Contacts', Icon: Users },
  { key: 'tasks', label: 'Tasks', Icon: ListChecks },
  { key: 'drive', label: 'Drive', Icon: FolderOpen },
];

export function RightPane({
  driveFolderId,
  onClose,
}: {
  // calendarSrc is retained on the type for QueueClient's call site; the native
  // Calendar panel reads the OAuth grant, so it is no longer consumed here.
  calendarSrc?: string;
  driveFolderId: string;
  onClose: () => void;
}) {
  const [active, setActive] = useState<PanelKey>('calendar');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PANEL_PREF_KEY);
      if (saved && PANELS.some((p) => p.key === saved)) setActive(saved as PanelKey);
    } catch {
      // localStorage unavailable — keep default.
    }
  }, []);

  const select = (k: PanelKey) => {
    setActive(k);
    try {
      localStorage.setItem(PANEL_PREF_KEY, k);
    } catch {
      // best-effort persistence
    }
  };

  const activeMeta = PANELS.find((p) => p.key === active) ?? PANELS[0];

  return (
    <section className="flex h-full min-w-0 flex-1 flex-row bg-bg-deep">
      {/* Active panel surface (left of the rail) */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-panel px-3">
          <activeMeta.Icon className="h-3.5 w-3.5 text-ink-muted" aria-hidden />
          <span className="font-mono text-[11px] text-ink">{activeMeta.label}</span>
          <button
            type="button"
            onClick={onClose}
            title="Hide right pane"
            aria-label="Hide right pane"
            className="ml-auto rounded-sm p-1 text-ink-dim hover:bg-bg-deep hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          {active === 'calendar' && <CalendarPanel />}
          {active === 'contacts' && <ContactsPanel />}
          {active === 'tasks' && <TasksPanel />}
          {active === 'drive' && <DrivePanel driveFolderId={driveFolderId} />}
        </div>
      </div>

      {/* Far-right icon rail (Gmail-style selection buttons) */}
      <nav
        aria-label="Side panels"
        className="flex w-11 shrink-0 flex-col items-center gap-1 border-l border-border-subtle bg-bg-panel py-2"
      >
        {PANELS.map(({ key, label, Icon }) => {
          const isActive = key === active;
          return (
            <button
              key={key}
              type="button"
              onClick={() => select(key)}
              aria-pressed={isActive}
              title={label}
              aria-label={label}
              className={`flex h-9 w-9 items-center justify-center rounded-sm transition-colors ${
                isActive
                  ? 'bg-bg-deep text-accent-blue'
                  : 'text-ink-dim hover:bg-bg-deep hover:text-ink'
              }`}
            >
              <Icon className="h-[18px] w-[18px]" aria-hidden />
            </button>
          );
        })}
      </nav>
    </section>
  );
}
