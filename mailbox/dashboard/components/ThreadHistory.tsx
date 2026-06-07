import { formatEmailBody } from '@/lib/format-body';
import type { ThreadMessage } from '@/lib/types';
import { TimeAgo } from './TimeAgo';

export function ThreadHistory({ messages }: { messages: ThreadMessage[] }) {
  if (messages.length === 0) return null;

  return (
    <details className="group rounded-sm border border-border-subtle">
      <summary className="cursor-pointer list-none select-none px-3 py-1.5 font-mono text-[11px] text-ink-dim hover:text-ink-muted">
        <span className="group-open:hidden">Conversation history ({messages.length} prior) ▸</span>
        <span className="hidden group-open:inline">
          Conversation history ({messages.length} prior) ▾
        </span>
      </summary>
      <ul className="space-y-1 border-t border-border-subtle bg-bg-deep px-2 py-2">
        {messages.map((m) => (
          <li key={`${m.direction}-${m.id}`}>
            <ThreadMessageRow message={m} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function ThreadMessageRow({ message }: { message: ThreadMessage }) {
  const directionTone =
    message.direction === 'inbound'
      ? 'border-border bg-bg-panel text-ink-muted'
      : 'border-accent-blue/40 bg-accent-blue/10 text-accent-blue';
  return (
    <details className="group/msg rounded-sm border border-border-subtle bg-bg-panel/40">
      <summary className="flex cursor-pointer list-none select-none items-center gap-2 px-2 py-1 text-[11px] hover:bg-bg-panel/70">
        <span
          className={`shrink-0 rounded-xs border px-1.5 py-0.5 font-mono uppercase tracking-wider ${directionTone}`}
        >
          {message.direction}
        </span>
        <span className="shrink-0 truncate font-mono text-ink-muted">
          {message.from_addr ?? '—'}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-ink-dim">
          {message.subject ?? '—'}
        </span>
        <span className="shrink-0 font-mono text-ink-dim">
          <TimeAgo iso={message.at} />
        </span>
      </summary>
      {message.body && (
        <div className="border-t border-border-subtle px-2 pb-2 pt-1.5">
          <pre className="whitespace-pre-wrap wrap-break-word font-serif text-sm leading-relaxed text-ink-muted">
            {formatEmailBody(message.body)}
          </pre>
        </div>
      )}
    </details>
  );
}
