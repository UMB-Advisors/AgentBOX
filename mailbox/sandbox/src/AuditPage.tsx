// STAQPRO-414 sandbox UX iteration — state transition audit log viewer.
//
// Surfaces the `mailbox.state_transitions` audit trail (STAQPRO-185) as a
// global feed with filters. Sandbox runs against synthetic fixtures
// (`fixtures/audit.ts`); Phase 2 dashboard port hits `/dashboard/audit` with
// `getRecentTransitions({...})` against the live table.

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  History,
  Bot,
  User,
  Cog,
  CheckCircle2,
  XCircle,
  Send as SendIcon,
  AlertTriangle,
  RotateCw,
  Pencil,
  Cloud,
  Sparkles,
} from "lucide-react";
import clsx from "clsx";
import {
  auditTransitions,
  type AuditActor,
  type AuditReason,
  type AuditStatus,
  type AuditTransition,
} from "./fixtures/audit";

interface AuditPageProps {
  onBack: () => void;
  onOpenDraft: (draftId: number) => void;
}

const ALL_ACTORS: readonly AuditActor[] = ["operator", "system", "n8n"];
const ALL_REASONS: readonly AuditReason[] = [
  "approve",
  "retry",
  "reject",
  "edit",
  "send",
  "cloud_route",
  "draft_finalize",
  "send_failure",
  "manual_resend",
  "classify",
];

const STATUS_PILL: Record<AuditStatus, string> = {
  pending: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  approved: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  sent: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  rejected: "bg-rose-50 text-rose-700 ring-rose-200",
  edited: "bg-amber-50 text-amber-700 ring-amber-200",
  awaiting_cloud: "bg-violet-50 text-violet-700 ring-violet-200",
};

const ACTOR_ICON: Record<AuditActor, typeof Bot> = {
  operator: User,
  system: Cog,
  n8n: Bot,
};

const REASON_ICON: Record<AuditReason, typeof CheckCircle2> = {
  approve: CheckCircle2,
  retry: RotateCw,
  reject: XCircle,
  edit: Pencil,
  send: SendIcon,
  cloud_route: Cloud,
  draft_finalize: Sparkles,
  send_failure: AlertTriangle,
  manual_resend: SendIcon,
  classify: Sparkles,
};

function relativeTime(iso: string, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  const m = Math.round(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function ChipToggle<T extends string>({
  options,
  selected,
  onToggle,
}: {
  options: readonly T[];
  selected: ReadonlySet<T>;
  onToggle: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => {
        const isActive = selected.has(o);
        return (
          <button
            key={o}
            type="button"
            onClick={() => onToggle(o)}
            className={clsx(
              "rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 transition-colors",
              isActive
                ? "bg-indigo-600 text-white ring-indigo-600"
                : "bg-white text-zinc-700 ring-zinc-200 hover:bg-zinc-50",
            )}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

export function AuditPage({ onBack, onOpenDraft }: AuditPageProps) {
  const [actorFilter, setActorFilter] = useState<ReadonlySet<AuditActor>>(new Set());
  const [reasonFilter, setReasonFilter] = useState<ReadonlySet<AuditReason>>(new Set());
  const [draftFilter, setDraftFilter] = useState<number | null>(null);
  const now = useMemo(() => new Date("2026-05-18T18:00:00Z"), []);

  function toggleActor(a: AuditActor) {
    setActorFilter((s) => {
      const next = new Set(s);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
  }
  function toggleReason(r: AuditReason) {
    setReasonFilter((s) => {
      const next = new Set(s);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });
  }

  const filtered = useMemo(() => {
    return auditTransitions
      .filter((t) => actorFilter.size === 0 || actorFilter.has(t.actor))
      .filter((t) => reasonFilter.size === 0 || reasonFilter.has(t.reason))
      .filter((t) => draftFilter === null || t.draft_id === draftFilter)
      .sort((a, b) => b.happened_at.localeCompare(a.happened_at));
  }, [actorFilter, reasonFilter, draftFilter]);

  const groups = useMemo(() => {
    const m: Record<string, AuditTransition[]> = {};
    for (const t of filtered) {
      const day = t.happened_at.slice(0, 10);
      (m[day] ??= []).push(t);
    }
    return Object.entries(m).sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  const totalActiveFilters =
    actorFilter.size + reasonFilter.size + (draftFilter !== null ? 1 : 0);

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
        <History className="h-4 w-4 text-zinc-700" />
        <span className="text-sm font-semibold text-zinc-800">Audit log</span>
        <span className="text-xs text-zinc-500">
          {filtered.length} {filtered.length === 1 ? "transition" : "transitions"}
          {draftFilter !== null && ` for draft #${draftFilter}`}
        </span>
        {totalActiveFilters > 0 && (
          <button
            type="button"
            onClick={() => {
              setActorFilter(new Set());
              setReasonFilter(new Set());
              setDraftFilter(null);
            }}
            className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700 hover:bg-indigo-100"
          >
            Clear {totalActiveFilters} filter{totalActiveFilters === 1 ? "" : "s"}
          </button>
        )}
        <span className="ml-auto rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
          Sandbox stub
        </span>
      </div>

      <div className="flex flex-col gap-2 border-b border-zinc-100 bg-white px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Actor
          </span>
          <ChipToggle options={ALL_ACTORS} selected={actorFilter} onToggle={toggleActor} />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Reason
          </span>
          <ChipToggle options={ALL_REASONS} selected={reasonFilter} onToggle={toggleReason} />
        </div>
        {draftFilter !== null && (
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              Draft
            </span>
            <button
              type="button"
              onClick={() => setDraftFilter(null)}
              className="inline-flex items-center gap-1 rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white"
              title="Clear draft filter"
            >
              #{draftFilter}
              <span className="text-indigo-200">×</span>
            </button>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        {filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-500">
            <p className="font-medium text-zinc-600">No transitions match these filters.</p>
            <p className="text-xs">Try clearing one.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map(([day, rows]) => (
              <section key={day}>
                <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  {new Date(day).toLocaleDateString("en-US", {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  })}
                  <span className="ml-2 text-zinc-400">({rows.length})</span>
                </h3>
                <ul className="space-y-1.5">
                  {rows.map((t) => {
                    const ActorIcon = ACTOR_ICON[t.actor];
                    const ReasonIcon = REASON_ICON[t.reason];
                    return (
                      <li
                        key={t.id}
                        className="flex items-start gap-3 rounded-md border border-zinc-100 bg-white px-3 py-2 text-xs"
                      >
                        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-100">
                          <ReasonIcon className="h-3.5 w-3.5 text-zinc-600" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {t.old_status ? (
                              <>
                                <StatusPill status={t.old_status} />
                                <ArrowRight className="h-3 w-3 text-zinc-400" />
                              </>
                            ) : null}
                            <StatusPill status={t.new_status} />
                            <span className="text-zinc-400">·</span>
                            <span className="font-medium text-zinc-700">{t.reason}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
                            <ActorIcon className="h-3 w-3" />
                            <span>{t.actor}</span>
                            <span>·</span>
                            <button
                              type="button"
                              onClick={() => setDraftFilter(t.draft_id)}
                              className="rounded px-1 text-indigo-600 hover:bg-indigo-50"
                              title="Show only this draft"
                            >
                              draft #{t.draft_id}
                            </button>
                            <button
                              type="button"
                              onClick={() => onOpenDraft(t.draft_id)}
                              className="rounded px-1 text-zinc-500 hover:bg-zinc-100"
                              title="Open this draft"
                            >
                              open ↗
                            </button>
                          </div>
                        </div>
                        <span
                          className="shrink-0 self-center text-[11px] text-zinc-500"
                          title={t.happened_at}
                        >
                          {relativeTime(t.happened_at, now)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      <p className="border-t border-zinc-200 bg-white px-4 py-2 text-[11px] text-zinc-500">
        Sandbox stub — fed by synthetic fixtures. Phase 2 reads from{" "}
        <code className="rounded bg-zinc-100 px-1 py-0.5">mailbox.state_transitions</code> via a new
        {" "}<code className="rounded bg-zinc-100 px-1 py-0.5">getRecentTransitions()</code> query helper.
        Per-draft timeline (in the draft detail pane) reuses this same row layout.
      </p>
    </main>
  );
}

function StatusPill({ status }: { status: AuditStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1",
        STATUS_PILL[status],
      )}
    >
      {status}
    </span>
  );
}
