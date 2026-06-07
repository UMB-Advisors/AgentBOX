'use client';

import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useEffect } from 'react';

// STAQPRO-331 #9 — toast now accepts an optional `action` (label + onClick)
// so reject success can offer Undo, and a `durationMs` override so high-value
// confirmations (Undo) can linger longer than the default 4s. Esc dismisses
// the toast globally — small UX win, no extra deps.
export function Toast({
  kind,
  text,
  action,
  durationMs = 4000,
  onDismiss,
}: {
  kind: 'success' | 'error';
  text: string;
  action?: { label: string; onClick: () => void };
  durationMs?: number;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timeout = setTimeout(onDismiss, durationMs);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('keydown', onKey);
    };
  }, [onDismiss, durationMs]);

  const Icon = kind === 'success' ? CheckCircle2 : AlertCircle;
  const palette =
    kind === 'success'
      ? 'border-accent-green/40 bg-accent-green/10 text-accent-green'
      : 'border-accent-red/40 bg-accent-red/10 text-accent-red';

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-4 left-4 right-4 z-50 inline-flex items-start gap-2 rounded-sm border px-3 py-2 font-sans text-sm shadow-lg sm:left-auto sm:max-w-md ${palette}`}
    >
      <Icon size={16} className="mt-0.5 shrink-0" />
      <span className="flex-1 wrap-break-word">{text}</span>
      {action && (
        <button
          type="button"
          onClick={() => {
            action.onClick();
            onDismiss();
          }}
          className="ml-2 shrink-0 rounded-sm border border-current/40 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider hover:bg-current/10"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
