import { formatEmailBody } from '@/lib/format-body';
import type { InboxMessage, ThreadMessage } from '@/lib/types';
import { ThreadHistory } from './ThreadHistory';

export function EmailContext({
  message,
  history = [],
}: {
  message: InboxMessage;
  history?: ThreadMessage[];
}) {
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 font-mono text-xs">
        <Row label="From" value={message.from_addr} />
        <Row label="To" value={message.to_addr} />
        <Row label="Subject" value={message.subject} />
        {message.received_at && (
          <Row label="Received" value={formatTimestamp(message.received_at)} muted />
        )}
      </dl>
      <ThreadHistory messages={history} />
      {message.body && (
        // STAQPRO-148-followup (Delphi UX pass) — inbound body is reference
        // material, not the primary task. Collapsed by default so the action
        // bar + draft body stay above the fold. Native <details> is keyboard-
        // accessible (Space/Enter to toggle) — no ARIA, no JS state.
        <details className="group rounded-sm border border-border-subtle">
          <summary className="cursor-pointer list-none select-none px-3 py-1.5 font-mono text-[11px] text-ink-dim hover:text-ink-muted">
            <span className="group-open:hidden">Show inbound email ▸</span>
            <span className="hidden group-open:inline">Hide inbound email ▾</span>
          </summary>
          <div className="border-t border-border-subtle bg-bg-deep px-3 pb-3 pt-2">
            <pre className="whitespace-pre-wrap wrap-break-word font-serif text-sm leading-relaxed text-ink-muted">
              {formatEmailBody(message.body)}
            </pre>
          </div>
        </details>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string | null;
  muted?: boolean;
}) {
  return (
    <>
      <dt className="text-ink-dim">{label}:</dt>
      <dd className={muted ? 'text-ink-muted' : 'text-ink'}>{value ?? '—'}</dd>
    </>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
