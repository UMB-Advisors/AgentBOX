import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock, Inbox, Send } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Markdown } from "@/components/Markdown";
import { api } from "@/lib/api";
import type {
  BriefDraftItem,
  DailyBriefResponse,
  DigestResponse,
} from "@/lib/api";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Daily-brief view (MBOX-479) — port of the mailbox-dashboard /daily-brief
 * surface into the Hermes dash. Two data sources, by design:
 *
 *  - NATIVE digest narrative: ``GET /api/digest/latest`` (gbrain markdown) —
 *    the same summary the Home landing renders. Read-only.
 *  - PROXIED mailbox pipeline widgets: ``GET /api/daily-brief`` →
 *    on-box mailbox-dashboard. Pending-by-category, urgent-untouched, and the
 *    oldest-waiting tail are computed from the mailbox Postgres pipeline
 *    (lib/queries-digest.ts:getDigestPayload); hermes_cli has no DB driver, so
 *    it proxies (same model as Classifications / Job Outcomes). If the upstream
 *    JSON route is not present yet the widgets degrade to a clean empty state.
 *
 * Read-only surface — no actions. Job-outcomes is intentionally NOT duplicated
 * here; it already lives on the Home landing (PR #29).
 */

const EMPTY_BRIEF: DailyBriefResponse = {
  counts_by_category: [],
  urgent_untouched: [],
  oldest_pending: [],
};

const URGENT_BODY_LIMIT = 8;

/** Hours → a compact age label (e.g. ``45m`` / ``3.2h`` / ``2d``). */
function formatAgeHours(h: number): string {
  if (!Number.isFinite(h) || h < 0) return "";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function DailyBriefPage() {
  const { setTitle } = usePageHeader();
  useEffect(() => {
    setTitle("Daily Brief");
  }, [setTitle]);

  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [brief, setBrief] = useState<DailyBriefResponse | null>(null);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    // ``loading`` starts true; this effect runs once on mount (empty deps), so
    // no synchronous setLoading(true) is needed here.
    // The native digest always answers 200; the proxied brief may 404/502 when
    // the mailbox upstream route is absent — degrade that to an empty brief
    // (with a soft note) rather than failing the whole view.
    Promise.allSettled([api.getDigest(), api.getDailyBrief()]).then(
      ([digestRes, briefRes]) => {
        if (!alive) return;
        if (digestRes.status === "fulfilled") setDigest(digestRes.value);
        if (briefRes.status === "fulfilled") {
          setBrief(briefRes.value);
          setBriefError(null);
        } else {
          setBrief(EMPTY_BRIEF);
          setBriefError(
            briefRes.reason instanceof Error
              ? briefRes.reason.message
              : "Mailbox pipeline data is unavailable.",
          );
        }
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const pendingTotal = useMemo(
    () =>
      (brief?.counts_by_category ?? []).reduce((sum, c) => sum + c.count, 0),
    [brief],
  );
  const urgentCount = brief?.urgent_untouched.length ?? 0;

  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    [],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-text-secondary">
        <Spinner />
        <span>Loading brief…</span>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <CardDescription>
        {today} — the same daily rollup as your email digest: what is waiting,
        what is urgent, and what has been waiting longest.
      </CardDescription>

      {/* At a glance — pipeline counters. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Pending"
          value={pendingTotal}
          sub="awaiting your action"
          icon={<Inbox className="h-4 w-4" />}
        />
        <Stat
          label="Urgent"
          value={urgentCount}
          sub="any urgency signal"
          tone={urgentCount > 0 ? "warning" : "default"}
          icon={<AlertTriangle className="h-4 w-4" />}
        />
        <Stat
          label="Sent"
          value={brief?.health?.sent_24h ?? 0}
          sub="last 24h"
          tone="success"
          icon={<Send className="h-4 w-4" />}
        />
        <Stat
          label="Stuck"
          value={brief?.health?.stuck_approved ?? 0}
          sub="approved, send unconfirmed"
          tone={(brief?.health?.stuck_approved ?? 0) > 0 ? "warning" : "default"}
          icon={<Clock className="h-4 w-4" />}
        />
      </div>

      {briefError && (
        <p className="text-xs text-text-tertiary">
          Mailbox pipeline data unavailable — showing the digest narrative only.
        </p>
      )}

      {/* Native gbrain digest narrative. */}
      <Card>
        <CardHeader>
          <CardTitle>Today’s digest</CardTitle>
          <CardDescription>
            {digest?.generated_at
              ? `Generated ${new Date(digest.generated_at).toLocaleString()}`
              : "Live summary from your knowledge graph."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {digest?.markdown ? (
            <Markdown content={digest.markdown} />
          ) : (
            <p className="text-sm text-text-secondary">
              No digest summary yet — it builds as the box processes your inbox.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Pending by category (proxied). */}
      <Card>
        <CardHeader>
          <CardTitle>Pending by category</CardTitle>
        </CardHeader>
        <CardContent>
          {(brief?.counts_by_category.length ?? 0) === 0 ? (
            <p className="text-sm text-text-secondary">
              No drafts awaiting action.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {brief?.counts_by_category.map((c) => (
                <li
                  key={c.category ?? "unclassified"}
                  className="flex items-baseline justify-between"
                >
                  <span className="text-text-secondary">
                    {c.category ?? "unclassified"}
                  </span>
                  <span className="tabular-nums">{c.count}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Urgent — needs your eyes (proxied). */}
      {urgentCount > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Urgent — needs your eyes</CardTitle>
            <CardDescription>Drafts firing an urgency signal.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {brief?.urgent_untouched.slice(0, URGENT_BODY_LIMIT).map((d) => (
              <DraftRow key={d.draft_id} draft={d} />
            ))}
            {urgentCount > URGENT_BODY_LIMIT && (
              <p className="text-xs text-text-tertiary">
                +{urgentCount - URGENT_BODY_LIMIT} more in the Incoming queue.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Oldest waiting (proxied). */}
      {(brief?.oldest_pending.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Oldest waiting</CardTitle>
            <CardDescription>
              What has been in the queue the longest.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {brief?.oldest_pending.map((d) => (
              <DraftRow key={d.draft_id} draft={d} />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface StatProps {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "default" | "success" | "warning" | "destructive";
  icon?: React.ReactNode;
}

function Stat({ label, value, sub, tone = "default", icon }: StatProps) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "destructive"
          ? "text-destructive"
          : "text-foreground";
  return (
    <div className="rounded border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-text-tertiary">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-text-tertiary">{sub}</div>}
    </div>
  );
}

function DraftRow({ draft }: { draft: BriefDraftItem }) {
  const age = formatAgeHours(draft.age_hours);
  return (
    <div className="rounded border border-border bg-card p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-sm">
          {draft.subject || "(no subject)"}
        </span>
        {age && (
          <span className="shrink-0 text-xs text-text-tertiary">{age}</span>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="truncate text-xs text-text-secondary">
          {draft.from_addr || "unknown sender"}
        </span>
        {draft.signals.length > 0 && (
          <Badge tone="warning" className="shrink-0">
            {draft.signals.join(" · ")}
          </Badge>
        )}
      </div>
    </div>
  );
}
