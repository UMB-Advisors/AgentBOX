// STAQPRO-413 sandbox UX iteration — cross-thread search.
//
// Sandbox surface for the eventual /api/internal/search + results UI. The
// "ranking" here is a lexical token-overlap proxy (not real semantic recall).
// The Phase 2 dashboard port replaces this with embedText() + Qdrant search
// over the existing email_messages collection (STAQPRO-188 / STAQPRO-190).
//
// What stays portable from this iteration:
// - Result row layout (sender + date + direction pill + category + excerpt)
// - Filter controls shape (direction tri-state, category multi-select)
// - Empty state copy
// - Click-to-open contract (navigate to draft detail)

import { useMemo } from "react";
import { ArrowLeft, ArrowDownLeft, ArrowUpRight, Search as SearchIcon } from "lucide-react";
import clsx from "clsx";
import { drafts as fixtureDrafts, type DraftRow } from "./fixtures/drafts";

type DirectionFilter = "any" | "inbound" | "outbound";

interface SearchResultsPageProps {
  query: string;
  directionFilter: DirectionFilter;
  onDirectionChange: (next: DirectionFilter) => void;
  onOpenDraft: (id: number) => void;
  onBack: () => void;
}

interface MaterializedMsg {
  id: number; // for inbound: draft.id ; for synthetic outbound: -draft.id
  direction: "inbound" | "outbound";
  from_addr: string;
  to_addr: string;
  subject: string;
  body: string;
  at: string;
  classification_category: string;
}

// Synthesize an outbound message for every sent/approved draft so the search
// corpus covers both directions. The body is a fabricated reply paraphrase —
// enough to let the operator demo "what did I say about X" type queries.
function buildCorpus(drafts: readonly DraftRow[]): MaterializedMsg[] {
  const out: MaterializedMsg[] = [];
  for (const d of drafts) {
    out.push({
      id: d.id,
      direction: "inbound",
      from_addr: d.from_addr,
      to_addr: "ops@yourbusiness.com",
      subject: d.subject,
      body: d.inbound_body_preview ?? "",
      at: d.received_at ?? d.created_at,
      classification_category: d.classification_category,
    });
    if (d.status === "sent" || d.status === "approved") {
      out.push({
        id: -d.id,
        direction: "outbound",
        from_addr: "ops@yourbusiness.com",
        to_addr: d.from_addr,
        subject: `Re: ${d.subject}`,
        body: (d.draft_body ?? "").slice(0, 600),
        at: d.sent_at ?? d.created_at,
        classification_category: d.classification_category,
      });
    }
  }
  return out;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

interface Scored {
  msg: MaterializedMsg;
  score: number;
  hitTerms: ReadonlySet<string>;
}

function score(corpus: MaterializedMsg[], q: string): Scored[] {
  const terms = Array.from(new Set(tokenize(q)));
  if (terms.length === 0) return [];
  const now = Date.now();
  const scored: Scored[] = [];
  for (const msg of corpus) {
    const hay = `${msg.subject} ${msg.body}`.toLowerCase();
    const hits = new Set<string>();
    let s = 0;
    for (const t of terms) {
      if (hay.includes(t)) {
        hits.add(t);
        s += 1;
        if (msg.subject.toLowerCase().includes(t)) s += 0.5; // subject hit bonus
      }
    }
    if (s === 0) continue;
    // Recency: linear decay over 30d, capped
    const ageMs = now - new Date(msg.at).getTime();
    const ageBoost = Math.max(0, 1 - ageMs / (30 * 24 * 60 * 60 * 1000)) * 0.5;
    scored.push({ msg, score: s + ageBoost, hitTerms: hits });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 30);
}

function excerpt(body: string, terms: ReadonlySet<string>, max = 220): string {
  if (!body) return "";
  const lower = body.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx === -1) return body.slice(0, max);
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, start + max);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < body.length ? "…" : "";
  return prefix + body.slice(start, end).replace(/\s+/g, " ") + suffix;
}

function highlight(text: string, terms: ReadonlySet<string>): React.ReactNode {
  if (terms.size === 0) return text;
  // Build a regex that matches any term (case-insensitive). Escape regex chars.
  const pattern = Array.from(terms)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!pattern) return text;
  const re = new RegExp(`(${pattern})`, "ig");
  const parts = text.split(re);
  return parts.map((p, i) =>
    re.test(p) ? (
      <mark key={i} className="rounded-sm bg-amber-100 px-0.5 text-zinc-900">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function senderName(addr: string): string {
  if (!addr) return "(unknown)";
  const local = addr.split("@")[0];
  return local
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() + p.slice(1))
    .join(" ");
}

const CATEGORY_PILL: Record<string, string> = {
  escalate: "bg-red-100 text-red-700 ring-red-200",
  reorder: "bg-blue-100 text-blue-700 ring-blue-200",
  inquiry: "bg-emerald-100 text-emerald-700 ring-emerald-200",
  scheduling: "bg-amber-100 text-amber-800 ring-amber-200",
  follow_up: "bg-violet-100 text-violet-700 ring-violet-200",
  internal: "bg-slate-100 text-slate-700 ring-slate-200",
  spam_marketing: "bg-zinc-100 text-zinc-600 ring-zinc-200",
  unknown: "bg-zinc-100 text-zinc-600 ring-zinc-200",
};

export function SearchResultsPage({
  query,
  directionFilter,
  onDirectionChange,
  onOpenDraft,
  onBack,
}: SearchResultsPageProps) {
  const corpus = useMemo(() => buildCorpus(fixtureDrafts), []);
  const scored = useMemo(() => {
    const all = score(corpus, query);
    if (directionFilter === "any") return all;
    return all.filter((s) => s.msg.direction === directionFilter);
  }, [corpus, query, directionFilter]);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-zinc-50">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-full p-1.5 hover:bg-zinc-100"
          title="Back to inbox"
        >
          <ArrowLeft className="h-4 w-4 text-zinc-600" />
        </button>
        <SearchIcon className="h-4 w-4 text-zinc-700" />
        <span className="text-sm font-semibold text-zinc-800">
          {query.trim() ? <>Results for &ldquo;{query}&rdquo;</> : "Search"}
        </span>
        <span className="text-xs text-zinc-500">
          {scored.length} {scored.length === 1 ? "match" : "matches"} across inbound + outbound
        </span>
        <span className="ml-auto rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
          Sandbox stub
        </span>
      </div>

      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-100 bg-white px-3 text-xs">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Direction</span>
        {(["any", "inbound", "outbound"] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => onDirectionChange(d)}
            className={clsx(
              "rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 transition-colors",
              directionFilter === d
                ? "bg-indigo-600 text-white ring-indigo-600"
                : "bg-white text-zinc-700 ring-zinc-200 hover:bg-zinc-50",
            )}
          >
            {d === "any" ? "Any" : d === "inbound" ? "Received" : "Sent"}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {!query.trim() ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-zinc-500">
            <SearchIcon className="h-6 w-6 text-zinc-300" />
            <p className="font-medium text-zinc-600">Type to search</p>
            <p className="max-w-md text-xs">
              Searches inbound messages, outbound replies, and the broader email history.
              In production this runs on-device via Qdrant + nomic-embed-text — never sent to cloud.
            </p>
          </div>
        ) : scored.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-zinc-500">
            <p className="font-medium text-zinc-600">No matches</p>
            <p className="text-xs">
              Try fewer terms, or remove the direction filter.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {scored.map(({ msg, hitTerms, score }) => (
              <li key={`${msg.direction}-${msg.id}`}>
                <button
                  type="button"
                  onClick={() => onOpenDraft(Math.abs(msg.id))}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-white"
                >
                  <div
                    className={clsx(
                      "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1",
                      msg.direction === "inbound"
                        ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
                        : "bg-indigo-50 text-indigo-600 ring-indigo-200",
                    )}
                  >
                    {msg.direction === "inbound" ? (
                      <ArrowDownLeft className="h-3.5 w-3.5" />
                    ) : (
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 text-sm">
                      <span className="font-medium text-zinc-900">
                        {senderName(msg.direction === "inbound" ? msg.from_addr : msg.to_addr)}
                      </span>
                      <span className="text-xs text-zinc-500">
                        {msg.direction === "inbound" ? msg.from_addr : `to ${msg.to_addr}`}
                      </span>
                      <span
                        className={clsx(
                          "rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1",
                          CATEGORY_PILL[msg.classification_category] ?? CATEGORY_PILL.unknown,
                        )}
                      >
                        {msg.classification_category}
                      </span>
                      <span className="ml-auto text-xs text-zinc-500">
                        {new Date(msg.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-sm font-medium text-zinc-800">
                      {highlight(msg.subject, hitTerms)}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-zinc-600">
                      {highlight(excerpt(msg.body, hitTerms), hitTerms)}
                    </p>
                    <div className="mt-1 text-[10px] uppercase tracking-wide text-zinc-400">
                      score {score.toFixed(2)} · {hitTerms.size} term hit{hitTerms.size === 1 ? "" : "s"}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="border-t border-zinc-200 bg-white px-4 py-2 text-[11px] text-zinc-500">
        Sandbox stub — ranking is lexical token-overlap (subject hits weighted 1.5×, recency boost up to 0.5). Phase 2 ports to
        {" "}<code className="rounded bg-zinc-100 px-1 py-0.5">POST /api/internal/search</code>{" "}
        backed by Qdrant cosine over <code className="rounded bg-zinc-100 px-1 py-0.5">email_messages</code> (STAQPRO-188).
        Latency target &lt;300ms median.
      </p>
    </main>
  );
}
