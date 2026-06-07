// STAQPRO-411 sandbox UX iteration — weekly value rollup view.
//
// This is the design surface for the dashboard's eventual /dashboard/insights
// route. The Phase 2 port lifts these visuals into Next.js, swapping the
// fixture-fed `useMemo`s for queries against `mailbox.state_transitions` /
// `sent_history` / `inbox_messages` per the ticket's data-sources section.
//
// Clock is pinned to INSIGHTS_NOW so the rendered counts stay deterministic
// across sandbox runs (same pattern as DigestPreview).

import { useMemo, useState } from "react";
import { ArrowLeft, BarChart3, Sparkles } from "lucide-react";
import clsx from "clsx";
import { drafts as fixtureDrafts } from "./fixtures/drafts";

const INSIGHTS_NOW = new Date("2026-05-18T12:00:00+00:00");
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

interface InsightsPageProps {
  onBack: () => void;
}

// Match the queue's existing CATEGORY_COLORS rhythm. Importing from App.tsx
// would create a circular dep; redeclaring keeps the surface decoupled.
const CATEGORY_BAR_COLOR: Record<string, string> = {
  escalate: "bg-red-500",
  reorder: "bg-amber-500",
  inquiry: "bg-emerald-500",
  scheduling: "bg-blue-500",
  follow_up: "bg-violet-500",
  internal: "bg-zinc-500",
  spam_marketing: "bg-zinc-400",
  unknown: "bg-zinc-300",
};

function rowDate(row: { received_at: string | null; created_at: string }): Date {
  return new Date(row.received_at ?? row.created_at);
}

function inWindow(row: { received_at: string | null; created_at: string }): boolean {
  const t = rowDate(row).getTime();
  return INSIGHTS_NOW.getTime() - t <= WINDOW_MS && t <= INSIGHTS_NOW.getTime();
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
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

export function InsightsPage({ onBack }: InsightsPageProps) {
  const [minutesPerEmail, setMinutesPerEmail] = useState(3);

  const stats = useMemo(() => {
    const inRange = fixtureDrafts.filter(inWindow);
    const byStatus = { pending: 0, approved: 0, sent: 0, rejected: 0 };
    const byRoute = { local: 0, cloud: 0 };
    const byCategory: Record<string, number> = {};
    const bySender: Record<string, { count: number; lastAt: string }> = {};
    const byDay: Record<string, number> = {};

    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const d = new Date(INSIGHTS_NOW.getTime() - i * 24 * 60 * 60 * 1000);
      byDay[dayKey(d)] = 0;
    }

    for (const r of inRange) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

      const cloudRoute =
        r.classification_category === "escalate" ||
        r.classification_category === "unknown" ||
        (r.classification_confidence !== null && r.classification_confidence < 0.75);
      if (r.classification_category !== "spam_marketing") {
        if (cloudRoute) byRoute.cloud++;
        else byRoute.local++;
      }

      byCategory[r.classification_category] = (byCategory[r.classification_category] ?? 0) + 1;

      const sender = r.from_addr;
      const at = r.received_at ?? r.created_at;
      if (!bySender[sender] || bySender[sender].lastAt < at) {
        bySender[sender] = {
          count: (bySender[sender]?.count ?? 0) + 1,
          lastAt: at,
        };
      } else {
        bySender[sender].count++;
      }

      const dk = dayKey(rowDate(r));
      if (dk in byDay) byDay[dk]++;
    }

    const topSenders = Object.entries(bySender)
      .map(([addr, v]) => ({ addr, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const categoryEntries = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1]);

    const handled = byStatus.approved + byStatus.sent; // "edited" not tracked separately in sandbox fixtures
    const hoursSaved = (handled * minutesPerEmail) / 60;

    return {
      total: inRange.length,
      byStatus,
      byRoute,
      byCategory: categoryEntries,
      byDay: Object.entries(byDay),
      topSenders,
      handled,
      hoursSaved,
    };
  }, [minutesPerEmail]);

  const maxDay = Math.max(1, ...stats.byDay.map(([, n]) => n));
  const sparkPath = useMemo(() => {
    const w = 160;
    const h = 36;
    const step = w / Math.max(1, stats.byDay.length - 1);
    return stats.byDay
      .map(([, n], i) => {
        const x = i * step;
        const y = h - (n / maxDay) * h;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [stats.byDay, maxDay]);

  const maxCat = Math.max(1, ...stats.byCategory.map(([, n]) => n));

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
        <BarChart3 className="h-4 w-4 text-zinc-700" />
        <span className="text-sm font-semibold text-zinc-800">Insights</span>
        <span className="text-xs text-zinc-500">
          last {WINDOW_DAYS} days · ending {INSIGHTS_NOW.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </span>
        <span className="ml-auto rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
          Sandbox stub
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
        {/* Hero row — hours saved + counter cards */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div className="col-span-1 rounded-lg border border-indigo-200 bg-indigo-50 p-4 sm:col-span-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-600" />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700">
                Estimated time saved
              </span>
            </div>
            <p className="mt-2 font-mono text-3xl font-semibold text-indigo-900">
              {stats.hoursSaved.toFixed(1)}h
            </p>
            <p className="mt-1 text-xs text-indigo-700/80">
              {stats.handled} drafts handled this week × {minutesPerEmail} min/email
            </p>
            <label className="mt-3 flex items-center gap-2 text-[11px] text-indigo-800">
              <span className="shrink-0">min / email:</span>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={minutesPerEmail}
                onChange={(e) => setMinutesPerEmail(parseInt(e.target.value, 10))}
                className="flex-1 accent-indigo-600"
              />
              <span className="w-6 text-right font-medium tabular-nums">{minutesPerEmail}</span>
            </label>
          </div>
          <StatCard label="Total drafts" value={stats.total} sub="this week" />
          <StatCard
            label="Approved"
            value={stats.byStatus.approved + stats.byStatus.sent}
            sub={`${stats.byStatus.sent} sent`}
            accent="emerald"
          />
        </section>

        {/* Trend + by-status row */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="col-span-1 rounded-lg border border-zinc-200 bg-white p-4 sm:col-span-2">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
                Daily volume
              </span>
              <span className="text-xs text-zinc-500">
                peak {maxDay} on{" "}
                {(() => {
                  const peak = stats.byDay.find(([, n]) => n === maxDay);
                  return peak
                    ? new Date(peak[0]).toLocaleDateString("en-US", { weekday: "short" })
                    : "—";
                })()}
              </span>
            </div>
            <svg
              viewBox="0 0 160 36"
              className="mt-3 h-10 w-full"
              preserveAspectRatio="none"
              aria-hidden
            >
              <path
                d={sparkPath}
                fill="none"
                stroke="rgb(79 70 229)"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            <div className="mt-2 grid grid-cols-7 gap-1 text-[10px] uppercase tracking-wide text-zinc-500">
              {stats.byDay.map(([k, n]) => (
                <div key={k} className="text-center">
                  <div className="text-zinc-400">
                    {new Date(k).toLocaleDateString("en-US", { weekday: "narrow" })}
                  </div>
                  <div className="font-medium tabular-nums text-zinc-700">{n}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
              Route mix
            </span>
            <div className="mt-3 space-y-2 text-sm">
              <RouteRow label="Local (Qwen3)" count={stats.byRoute.local} total={stats.byRoute.local + stats.byRoute.cloud} tone="emerald" />
              <RouteRow label="Cloud (gpt-oss)" count={stats.byRoute.cloud} total={stats.byRoute.local + stats.byRoute.cloud} tone="amber" />
            </div>
          </div>
        </section>

        {/* By-category bar chart */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
            By category
          </span>
          <div className="mt-3 space-y-1.5">
            {stats.byCategory.map(([cat, n]) => (
              <div key={cat} className="flex items-center gap-3 text-xs">
                <span className="w-28 shrink-0 truncate text-zinc-700">{cat}</span>
                <div className="flex h-3 flex-1 items-center overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className={clsx("h-full rounded-full", CATEGORY_BAR_COLOR[cat] ?? "bg-zinc-400")}
                    style={{ width: `${(n / maxCat) * 100}%` }}
                  />
                </div>
                <span className="w-6 shrink-0 text-right tabular-nums text-zinc-600">{n}</span>
              </div>
            ))}
            {stats.byCategory.length === 0 && (
              <p className="text-xs text-zinc-500">No drafts in window.</p>
            )}
          </div>
        </section>

        {/* Top counterparties */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
            Top counterparties this week
          </span>
          <table className="mt-3 w-full text-sm">
            <tbody className="divide-y divide-zinc-100">
              {stats.topSenders.map((s) => (
                <tr key={s.addr}>
                  <td className="py-1.5 pr-3 font-medium text-zinc-800">{senderName(s.addr)}</td>
                  <td className="py-1.5 pr-3 text-xs text-zinc-500">{s.addr}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-zinc-700">{s.count}</td>
                  <td className="py-1.5 text-right text-xs text-zinc-500">
                    {new Date(s.lastAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </td>
                </tr>
              ))}
              {stats.topSenders.length === 0 && (
                <tr>
                  <td className="py-2 text-xs text-zinc-500" colSpan={4}>
                    No counterparties in window.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <p className="px-1 text-[11px] text-zinc-500">
          Sandbox stub — Phase 2 (<code className="rounded bg-zinc-100 px-1 py-0.5">/dashboard/insights</code>)
          replaces fixture-fed counts with queries against{" "}
          <code className="rounded bg-zinc-100 px-1 py-0.5">mailbox.state_transitions</code> +{" "}
          <code className="rounded bg-zinc-100 px-1 py-0.5">sent_history</code>.
          Operator-multiplier value persists to <code className="rounded bg-zinc-100 px-1 py-0.5">mailbox.persona</code> or a new <code className="rounded bg-zinc-100 px-1 py-0.5">operator_prefs</code> table — TBD in port.
        </p>
      </div>
    </main>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number;
  sub?: string;
  accent?: "emerald";
}) {
  return (
    <div
      className={clsx(
        "rounded-lg border bg-white p-4",
        accent === "emerald" ? "border-emerald-200" : "border-zinc-200",
      )}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
        {label}
      </span>
      <p
        className={clsx(
          "mt-2 font-mono text-3xl font-semibold tabular-nums",
          accent === "emerald" ? "text-emerald-700" : "text-zinc-800",
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

function RouteRow({
  label,
  count,
  total,
  tone,
}: {
  label: string;
  count: number;
  total: number;
  tone: "emerald" | "amber";
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-zinc-700">{label}</span>
        <span className="tabular-nums text-zinc-600">
          {count} <span className="text-zinc-400">({pct.toFixed(0)}%)</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100">
        <div
          className={clsx(
            "h-full rounded-full",
            tone === "emerald" ? "bg-emerald-500" : "bg-amber-500",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
