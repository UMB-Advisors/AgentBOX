'use client';

import type { DraftingFlag } from '@/lib/drafting-flag';
import { TimeAgo } from './TimeAgo';

// MBOX-288 (DR-54 / §7.11.3) — honest in-flight indicator for the chat UI.
//
// Presentational only. The owner (the /dashboard/chat surface, MBOX-287) polls
// /api/system/drafting-flag and hands the resulting DraftingFlag in as a prop;
// this component never makes a drafting claim the flag didn't.
//
// Two honest states:
//   - flag.drafting === true  → "Drafting a reply to <name>…" (names the
//     counterparty when known; falls back to the subject, then to an unnamed
//     but still-true "Drafting a reply…"). Includes an honest elapsed time
//     from the live `since` timestamp — not a client-side guess.
//   - flag.drafting === false → plain "Thinking…", with NO drafting claim. Use
//     this whenever the stall is cold-load, retrieval, or general slowness.
//
// SM-72: there is intentionally no code path that asserts "drafting" without
// flag.drafting being true — the discriminated union makes the false-positive
// case unrepresentable.
export function DraftingIndicator({ flag }: { flag: DraftingFlag }) {
  if (!flag.drafting) {
    return (
      <div
        className="flex items-center gap-2 text-xs text-ink-muted"
        role="status"
        aria-live="polite"
      >
        <PulseDot color="bg-ink-dim" />
        <span>Thinking…</span>
      </div>
    );
  }

  // Name the counterparty when we have one; otherwise lean on the subject;
  // otherwise stay honest-but-unnamed. All three branches are true claims.
  const label = flag.counterparty
    ? `Drafting a reply to ${flag.counterparty}…`
    : flag.subject
      ? `Drafting a reply re: ${flag.subject}…`
      : 'Drafting a reply…';

  return (
    <div
      className="flex items-center gap-2 text-xs text-ink-muted"
      role="status"
      aria-live="polite"
    >
      <PulseDot color="bg-accent-orange" />
      <span className="truncate text-ink">{label}</span>
      {flag.since && (
        <span className="shrink-0 font-mono text-[11px] text-ink-dim tabular-nums">
          <TimeAgo iso={flag.since} />
        </span>
      )}
    </div>
  );
}

function PulseDot({ color }: { color: string }) {
  return <span className={`h-2 w-2 shrink-0 animate-pulse rounded-full ${color}`} aria-hidden />;
}
