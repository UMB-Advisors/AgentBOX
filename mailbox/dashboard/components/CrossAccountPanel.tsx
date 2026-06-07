'use client';

import { Inbox } from 'lucide-react';
import { useEffect, useState } from 'react';
import { TimeAgo } from './TimeAgo';

// MBOX-367 (MBOX-162 V4) — cross-account intelligence. "This counterparty also
// emailed your other inboxes." Fetches on mount (not on expand) so it can
// self-hide: on a single-account box, or when this sender only appears under
// the current inbox, the route returns no rows and the panel renders nothing —
// zero visual cost in the common case. Only surfaces the moat when it exists.

interface CrossAccountRow {
  account_id: number;
  account_email: string;
  account_label: string | null;
  total_emails: number;
  drafts_sent: number;
  last_seen_at: string | null;
}

type FetchState =
  | { kind: 'idle' }
  | { kind: 'empty' }
  | { kind: 'ok'; rows: CrossAccountRow[] }
  | { kind: 'error'; message: string };

export function CrossAccountPanel({ draftId }: { draftId: number }) {
  const [state, setState] = useState<FetchState>({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/drafts/${draftId}/cross-account`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        const rows = (data.rows ?? []) as CrossAccountRow[];
        setState(rows.length > 0 ? { kind: 'ok', rows } : { kind: 'empty' });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : 'unknown error' });
      });
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  // Inert in the common case — nothing to show while loading, when there's no
  // cross-account history, or on a single-account box.
  if (state.kind === 'idle' || state.kind === 'empty') return null;

  if (state.kind === 'error') {
    return (
      <section className="rounded-sm border border-border bg-bg-deep px-3 py-2 font-mono text-xs text-accent-red">
        Cross-account lookup failed: {state.message}
      </section>
    );
  }

  return (
    <section className="rounded-sm border border-accent-orange/40 bg-accent-orange/5 px-3 py-2 font-mono text-xs">
      <div className="mb-1.5 flex items-center gap-1.5 text-accent-orange">
        <Inbox size={13} />
        <span className="font-semibold">Also in your other inboxes</span>
      </div>
      <ul className="space-y-1">
        {state.rows.map((r) => (
          <li key={r.account_id} className="flex flex-wrap items-baseline gap-x-2 text-ink-muted">
            <span className="font-semibold text-ink">{r.account_label || r.account_email}</span>
            <span className="text-ink-dim">·</span>
            <span>
              {r.total_emails} email{r.total_emails === 1 ? '' : 's'}
            </span>
            {r.drafts_sent > 0 && (
              <>
                <span className="text-ink-dim">·</span>
                <span>{r.drafts_sent} replied</span>
              </>
            )}
            {r.last_seen_at && (
              <>
                <span className="text-ink-dim">·</span>
                <span className="text-ink-dim">
                  last <TimeAgo iso={r.last_seen_at} />
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
