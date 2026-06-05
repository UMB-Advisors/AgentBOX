import { BookOpen, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { RagRefsResponse } from "@/lib/api";

// "Sources used" — resolves a draft's rag/kb context refs back to the source
// messages the drafter saw, so an operator rejecting "factually inaccurate" /
// "missing context" can diagnose retrieval. Lazy-loads on first expand. Ported
// from mailbox-dashboard SourcesUsedPanel (STAQPRO-331 #2 / STAQPRO-333).

const REASON_LABEL: Record<string, string> = {
  ok: "retrieval succeeded",
  cloud_gated:
    "cloud-route draft — RAG retrieval is disabled by privacy default for cloud drafts",
  embed_unavailable:
    "embedding service was unreachable when this draft was assembled",
  qdrant_unavailable:
    "vector store was unreachable when this draft was assembled",
  no_hits: "no prior counterparty messages matched",
  disabled: "RAG was disabled by env override (eval mode)",
  none: "pre-RAG draft (predates the retrieval pipeline)",
};

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

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n).trimEnd()}…`;
}

export function SourcesUsedPanel({ draftId }: { draftId: number }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<RagRefsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-load on first expand. Parent passes key={draftId} so all local state
  // resets on draft switch — no reset effect needed.
  useEffect(() => {
    if (!open) return;
    if (data !== null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .inboxGetRagRefs(draftId)
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "unknown error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draftId]);

  const count = data?.refs.length ?? null;
  return (
    <section className="border border-border bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 p-3 text-sm text-muted-foreground hover:text-foreground"
      >
        <BookOpen size={14} aria-hidden />
        <span>Sources used</span>
        {count !== null && (
          <span className="rounded-full border border-border bg-background/40 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
        <ChevronDown
          size={14}
          className={`ml-auto transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open && (
        <div className="border-t border-border p-3">
          {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
          {error && (
            <p className="text-xs text-destructive">
              Failed to load sources: <span className="font-mono">{error}</span>
            </p>
          )}
          {data && <SourcesContent data={data} />}
        </div>
      )}
    </section>
  );
}

function SourcesContent({ data }: { data: RagRefsResponse }) {
  const errorBlock = (
    <>
      {data.qdrant_error &&
        data.unresolved_point_ids &&
        data.unresolved_point_ids.length > 0 && (
          <p className="text-xs text-warning">
            ⚠ Email Qdrant unreachable ({data.qdrant_error});{" "}
            {data.unresolved_point_ids.length} email ref
            {data.unresolved_point_ids.length === 1 ? "" : "s"} could not be
            resolved right now.
          </p>
        )}
      {data.kb_qdrant_error &&
        data.kb_unresolved_point_ids &&
        data.kb_unresolved_point_ids.length > 0 && (
          <p className="text-xs text-warning">
            ⚠ KB Qdrant unreachable ({data.kb_qdrant_error});{" "}
            {data.kb_unresolved_point_ids.length} KB ref
            {data.kb_unresolved_point_ids.length === 1 ? "" : "s"} could not be
            resolved right now.
          </p>
        )}
    </>
  );

  if (data.refs.length === 0) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          No sources retrieved for this draft.
        </p>
        <p className="text-xs text-muted-foreground">
          Reason: <span className="font-mono">{data.reason}</span>
          {REASON_LABEL[data.reason] && (
            <span className="ml-1">— {REASON_LABEL[data.reason]}</span>
          )}
        </p>
        {errorBlock}
      </div>
    );
  }

  const emailCount = data.refs.filter((r) => r.source === "email").length;
  const kbCount = data.refs.filter((r) => r.source === "kb").length;
  const breakdown =
    emailCount > 0 && kbCount > 0
      ? `${emailCount} email · ${kbCount} kb`
      : emailCount > 0
        ? `${emailCount} email`
        : `${kbCount} kb`;

  return (
    <div className="space-y-2">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {breakdown}
      </p>
      {errorBlock}
      <ul className="space-y-2">
        {data.refs.map((ref) => (
          <li
            key={ref.point_id}
            className="border border-border bg-background/30 p-2"
          >
            {ref.source === "email" ? (
              <>
                <div className="mb-1 flex items-baseline gap-2">
                  <span
                    className={`rounded-full border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                      ref.direction === "outbound"
                        ? "border-primary/40 text-primary"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    {ref.direction}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {ref.direction === "outbound"
                      ? `→ ${ref.recipient}`
                      : `from ${ref.sender}`}
                  </span>
                  <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                    {timeAgo(ref.sent_at)}
                  </span>
                </div>
                {ref.subject && (
                  <p className="mb-1 truncate text-sm font-medium text-foreground">
                    {ref.subject}
                  </p>
                )}
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {truncate(ref.body_excerpt, 240)}
                </p>
              </>
            ) : (
              <>
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="rounded-full border border-success/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-success">
                    KB
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {ref.doc_title}
                  </span>
                  <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                    uploaded {timeAgo(ref.uploaded_at)}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {truncate(ref.excerpt, 240)}
                </p>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
