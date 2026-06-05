import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { InboxRejectReasonCode, SenderHistory } from "@/lib/api";

// Per-counterparty acceptance stats. "This is the Nth email from sender X in
// 30 days; you've approved M/K prior drafts." Lazy-fetches on first expand.
// Ported from mailbox-dashboard SenderHistoryPanel (STAQPRO-331 #6).

const REJECT_REASON_LABELS: Record<InboxRejectReasonCode, string> = {
  wrong_tone: "Wrong tone",
  factually_inaccurate: "Factually inaccurate",
  missing_context: "Missing context",
  should_reply_myself: "Reply myself",
  dont_reply: "Don't reply",
  other: "Other",
};

type FetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; history: SenderHistory | null; reason?: string }
  | { kind: "error"; message: string };

export function SenderHistoryPanel({ draftId }: { draftId: number }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FetchState>({ kind: "idle" });

  useEffect(() => {
    if (!open || state.kind !== "idle") return;
    setState({ kind: "loading" });
    let cancelled = false;
    api
      .inboxGetSenderHistory(draftId)
      .then((data) => {
        if (cancelled) return;
        setState({ kind: "ok", history: data.history ?? null, reason: data.reason });
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
  }, [open, draftId, state.kind]);

  return (
    <section className="border border-border bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 font-mono text-xs text-muted-foreground"
      >
        <span>Sender history</span>
        {state.kind === "ok" && state.history && <Summary history={state.history} />}
        <ChevronDown
          size={14}
          className={`ml-auto transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2 font-mono text-xs text-muted-foreground">
          {state.kind === "loading" && <span>Loading…</span>}
          {state.kind === "error" && (
            <span className="text-destructive">Failed: {state.message}</span>
          )}
          {state.kind === "ok" && !state.history && (
            <span>
              {state.reason === "no_sender"
                ? "No sender on the inbound — nothing to aggregate."
                : "No history yet."}
            </span>
          )}
          {state.kind === "ok" && state.history && <Detail history={state.history} />}
        </div>
      )}
    </section>
  );
}

function Summary({ history }: { history: SenderHistory }) {
  const total = history.drafts_sent + history.drafts_rejected + history.drafts_edited;
  const acceptRate =
    total > 0
      ? Math.round(((history.drafts_sent + history.drafts_edited) / total) * 100)
      : null;
  return (
    <span className="flex items-center gap-2">
      <span>
        {history.total_emails} emails / {history.lookback_days}d
      </span>
      {acceptRate != null && (
        <span className={acceptRate >= 70 ? "text-success" : "text-warning"}>
          {acceptRate}% accept
        </span>
      )}
    </span>
  );
}

function Detail({ history }: { history: SenderHistory }) {
  const rows: Array<[string, string]> = [
    ["Sender", history.sender],
    ["Window", `${history.lookback_days} days`],
    ["Inbound emails", String(history.total_emails)],
    ["Drafts sent", String(history.drafts_sent)],
    ["Drafts approved (in flight)", String(history.drafts_approved)],
    ["Drafts edited", String(history.drafts_edited)],
    ["Drafts rejected", String(history.drafts_rejected)],
    ["Drafts pending", String(history.drafts_pending)],
    [
      "Mean classifier confidence",
      history.mean_confidence != null
        ? `${Math.round(history.mean_confidence * 100)}%`
        : "—",
    ],
    [
      "Top reject reason",
      history.top_reject_reason
        ? REJECT_REASON_LABELS[history.top_reject_reason]
        : "—",
    ],
  ];
  return (
    <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground/70">{label}</dt>
          <dd className="text-muted-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
