import { Inbox } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { CrossAccountRow } from "@/lib/api";

// Cross-account intelligence: "this counterparty also emailed your other
// inboxes." Fetches on mount so it can self-hide — on a single-account box, or
// when the sender only appears under the current inbox, the route returns no
// rows and the panel renders nothing. Ported from mailbox-dashboard
// CrossAccountPanel (MBOX-367).

type FetchState =
  | { kind: "idle" }
  | { kind: "empty" }
  | { kind: "ok"; rows: CrossAccountRow[] }
  | { kind: "error"; message: string };

function timeAgo(iso: string): string {
  const then = new Date(iso.replace(" ", "T")).getTime();
  if (Number.isNaN(then)) return iso;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function CrossAccountPanel({ draftId }: { draftId: number }) {
  const [state, setState] = useState<FetchState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    api
      .inboxGetCrossAccount(draftId)
      .then((data) => {
        if (cancelled) return;
        const rows = data.rows ?? [];
        setState(rows.length > 0 ? { kind: "ok", rows } : { kind: "empty" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "unknown error",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  // Inert in the common case — nothing while loading, no history, or single-account.
  if (state.kind === "idle" || state.kind === "empty") return null;

  if (state.kind === "error") {
    return (
      <section className="border border-border bg-background/40 px-3 py-2 font-mono text-xs text-destructive">
        Cross-account lookup failed: {state.message}
      </section>
    );
  }

  return (
    <section className="border border-warning/40 bg-warning/5 px-3 py-2 font-mono text-xs">
      <div className="mb-1.5 flex items-center gap-1.5 text-warning">
        <Inbox size={13} />
        <span className="font-semibold">Also in your other inboxes</span>
      </div>
      <ul className="space-y-1">
        {state.rows.map((r) => (
          <li
            key={r.account_id}
            className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground"
          >
            <span className="font-semibold text-foreground">
              {r.account_label || r.account_email}
            </span>
            <span>·</span>
            <span>
              {r.total_emails} email{r.total_emails === 1 ? "" : "s"}
            </span>
            {r.drafts_sent > 0 && (
              <>
                <span>·</span>
                <span>{r.drafts_sent} replied</span>
              </>
            )}
            {r.last_seen_at && (
              <>
                <span>·</span>
                <span>last {timeAgo(r.last_seen_at)}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
