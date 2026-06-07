'use client';

import { X } from 'lucide-react';
import { useEffect } from 'react';

// STAQPRO-331 #7 — keyboard shortcuts cheatsheet. Triggered by `?` from
// the QueueClient key handler. Click outside, click X, or Escape (handled
// in QueueClient before the popover-guard) closes it. Pure presentation;
// the source-of-truth for shortcut bindings lives in QueueClient.

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['j', '↓'], label: 'Next draft' },
  { keys: ['k', '↑'], label: 'Previous draft' },
  { keys: ['Enter', 'a'], label: 'Approve & send selected draft' },
  { keys: ['e'], label: 'Edit selected draft' },
  { keys: ['r', 'x'], label: 'Reject selected draft (opens reason picker)' },
  { keys: ['Esc'], label: 'Close popover / dismiss this help' },
  { keys: ['?'], label: 'Show this help' },
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-shortcuts-help]')) return;
      onClose();
    }
    // Defer outside-click capture so the same `?` keystroke that opened
    // the overlay doesn't immediately close it via the click that some
    // browsers synthesize on focus shifts.
    const t = setTimeout(() => document.addEventListener('click', onClickOutside), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('click', onClickOutside);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
      <div
        data-shortcuts-help
        className="w-[min(420px,calc(100vw-2rem))] rounded-sm border border-border bg-bg-panel p-4 shadow-lg"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-sans text-sm font-semibold">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm p-1 text-ink-dim hover:bg-bg-deep hover:text-ink"
            aria-label="Close shortcuts help"
          >
            <X size={16} />
          </button>
        </div>
        <dl className="space-y-1.5">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center gap-3">
              <dt className="flex shrink-0 gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="rounded-sm border border-border bg-bg-deep px-1.5 py-0.5 font-mono text-[11px] text-ink"
                  >
                    {k}
                  </kbd>
                ))}
              </dt>
              <dd className="font-sans text-xs text-ink-muted">{s.label}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 border-t border-border pt-2 font-sans text-[11px] text-ink-dim">
          Shortcuts are suppressed while typing in an input or while the reject reason picker is
          open.
        </p>
      </div>
    </div>
  );
}
