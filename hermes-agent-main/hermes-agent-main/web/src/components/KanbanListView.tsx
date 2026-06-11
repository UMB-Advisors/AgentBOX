import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleHelp, ExternalLink, MessageSquare, RefreshCw, X } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Checkbox } from "@nous-research/ui/ui/components/checkbox";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { useModalBehavior } from "@/hooks/useModalBehavior";
import { cn } from "@/lib/utils";
import {
  api,
  type KanbanBulkUpdateBody,
  type KanbanBoard,
  type KanbanCycle,
  type KanbanFilterState,
  type KanbanLabel,
  type KanbanMeta,
  type KanbanTask,
  type KanbanTaskMeta,
  type KanbanTaskMetaPatch,
  type KanbanUpdateTaskBody,
} from "@/lib/api";

// Linear-style list view over the native kanban board (PRD
// docs/kanban-linear-ux.v0.1.0.md §1.2). Reads the whole board in one
// `GET /api/plugins/kanban/board` call, groups rows by status / assignee /
// priority, and offers quick edits via a right-side detail panel plus a
// multi-select bulk bar (`POST /tasks/bulk`).
//
// Priority semantics — VERIFIED against hermes_cli/kanban_db.py: priority is
// a plain integer where HIGHER = MORE URGENT. The canonical "priority" sort
// is `priority DESC, created_at ASC` (VALID_SORT_ORDERS) and the dispatcher
// claims work `ORDER BY priority DESC`; default is 0. This is the OPPOSITE
// direction of Linear's 1=urgent scale. The UI exposes the 0–3 ladder
// implied by PRD §1.3's quick-add aliases (!urgent=3 !high=2 !medium=1
// !low=0); out-of-range ints still render as `P{n}`.

export type GroupBy = "status" | "assignee" | "priority";

/** Task-context actions shared by the row hotkeys (s/p/a/c) and the command
 *  palette submenus (PRD §1.4). */
export type TaskContextAction = "status" | "priority" | "assignee" | "comment";

interface TaskGroup {
  key: string;
  label: string;
  tasks: KanbanTask[];
}

// Board column order from the plugin API (plugin_api.BOARD_COLUMNS).
const STATUS_ORDER = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
];

// Statuses PATCH /tasks/:id accepts as a target. Neither "running" nor
// "review" is offered as an edit target, for different reasons: "running"
// is dispatcher-owned and the plugin API rejects it with a dedicated 400
// ("use the dispatcher/claim path"), while "review" has no transition
// implemented at all and falls through to the generic
// `unknown status: ...` 400 (plugin_api.py update_task's else branch).
// Tasks already in either still render, and their current status is
// prepended so the select isn't blank.
export const SETTABLE_STATUSES = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "blocked",
  "done",
  "archived",
];

// POST /tasks/bulk accepts a narrower set: no "archived" status target —
// bulk archiving is the separate `archive` flag, out of scope for the v1 bar.
const BULK_STATUSES = ["triage", "todo", "scheduled", "ready", "blocked", "done"];

export const PRIORITY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 3, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 1, label: "Medium" },
  { value: 0, label: "Low" },
];

// The bulk-bar selects are action-style (value stays "" so the placeholder
// always shows); an empty-string option value would collide with that idle
// state, so "unassign" rides a sentinel mapped to `assignee: ""` (the API
// unassigns on empty string).
const UNASSIGN_SENTINEL = "__unassign__";

export function priorityLabel(p: number): string {
  return PRIORITY_OPTIONS.find((o) => o.value === p)?.label ?? `P${p}`;
}

function priorityTone(p: number): "warning" | "secondary" | "outline" {
  if (p >= 3) return "warning";
  if (p === 2) return "secondary";
  return "outline";
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Compact age from seconds: "—", "45s", "12m", "5h", "3d" (cf. `timeAgo`
 *  in lib/utils, which takes an epoch — board tasks carry deltas). */
function fmtAge(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function taskAgeSeconds(t: KanbanTask): number | null {
  return t.age?.created_age_seconds ?? null;
}

// Due dates (PRD §2.2) are date-only ISO strings compared in the LOCAL
// timezone: parse YYYY-MM-DD into a local-midnight Date and diff against
// today's local midnight. "Due ≤ 48h" therefore means due today, tomorrow,
// or the day after (diff 0–2 days) — the date-only reading of 48 hours.
export function daysUntilDue(dueAt: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueAt);
  if (!m) return null;
  const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}

export function isOverdue(dueAt: string): boolean {
  const days = daysUntilDue(dueAt);
  return days != null && days < 0;
}

/** "Jun 14" in the local tz (the ISO string is already date-only). */
function fmtDueDate(dueAt: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueAt);
  if (!m) return dueAt;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
  ).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Due badge per PRD §2.2: red + "Overdue" when past, amber when due within
// 48h (date-only: today/tomorrow/day-after), neutral outline further out.
function DueBadge({ dueAt }: { dueAt: string }) {
  const days = daysUntilDue(dueAt);
  if (days == null) return null;
  if (days < 0) {
    return (
      <Badge tone="destructive" className="shrink-0">
        Overdue · {fmtDueDate(dueAt)}
      </Badge>
    );
  }
  return (
    <Badge tone={days <= 2 ? "warning" : "outline"} className="shrink-0">
      Due {fmtDueDate(dueAt)}
    </Badge>
  );
}

// Client-side FilterState application (PRD §2.1). Runs over the whole
// loaded board — an appliance board tops out at a few hundred tasks, so
// there's no server-side filtering (noted ceiling; revisit if that grows).
function applyFilter(
  tasks: KanbanTask[],
  filter: KanbanFilterState,
  meta: KanbanMeta | null,
): KanbanTask[] {
  const text = filter.text.trim().toLowerCase();
  return tasks.filter((t) => {
    if (filter.statuses.length && !filter.statuses.includes(t.status)) {
      return false;
    }
    if (
      filter.assignees.length &&
      !(t.assignee != null && filter.assignees.includes(t.assignee))
    ) {
      return false;
    }
    if (
      filter.tenants.length &&
      !(t.tenant != null && filter.tenants.includes(t.tenant))
    ) {
      return false;
    }
    const tm = meta?.tasks[t.id];
    if (
      filter.labels.length &&
      !(tm?.labels ?? []).some((l) => filter.labels.includes(l))
    ) {
      return false;
    }
    if (filter.cycleId != null && tm?.cycle_id !== filter.cycleId) {
      return false;
    }
    if (filter.overdueOnly && !(tm?.due_at != null && isOverdue(tm.due_at))) {
      return false;
    }
    if (
      text &&
      !t.title.toLowerCase().includes(text) &&
      !t.id.toLowerCase().includes(text)
    ) {
      return false;
    }
    return true;
  });
}

// In-group sort per PRD §1.2: priority desc, then age asc (newest first).
// NB the plugin board's canonical tiebreak is created_at ASC (oldest first);
// the PRD explicitly specifies "age asc" for the list, so the two views
// intentionally differ on priority ties.
function sortTasks(tasks: KanbanTask[]): KanbanTask[] {
  return [...tasks].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const ageA = taskAgeSeconds(a) ?? Number.MAX_SAFE_INTEGER;
    const ageB = taskAgeSeconds(b) ?? Number.MAX_SAFE_INTEGER;
    return ageA - ageB;
  });
}

// Empty groups are skipped (Linear hides them too) — with eight status
// columns, rendering empty shells buries the real work.
function groupTasks(tasks: KanbanTask[], groupBy: GroupBy): TaskGroup[] {
  const groups: TaskGroup[] = [];
  if (groupBy === "status") {
    for (const s of STATUS_ORDER) {
      const inStatus = tasks.filter((t) => t.status === s);
      if (inStatus.length) {
        groups.push({ key: s, label: s, tasks: sortTasks(inStatus) });
      }
    }
    // Anything off the canonical column list (defensive; the board endpoint
    // folds unknown statuses into "todo", but keep the list lossless).
    const known = new Set(STATUS_ORDER);
    const rest = tasks.filter((t) => !known.has(t.status));
    if (rest.length) {
      groups.push({ key: "__other__", label: "other", tasks: sortTasks(rest) });
    }
  } else if (groupBy === "assignee") {
    const names = [
      ...new Set(
        tasks.flatMap((t) => (t.assignee != null && t.assignee !== "" ? [t.assignee] : [])),
      ),
    ].sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      groups.push({
        key: name,
        label: name,
        tasks: sortTasks(tasks.filter((t) => t.assignee === name)),
      });
    }
    const unassigned = tasks.filter((t) => !t.assignee);
    if (unassigned.length) {
      groups.push({
        key: "__unassigned__",
        label: "unassigned",
        tasks: sortTasks(unassigned),
      });
    }
  } else {
    const priorities = [...new Set(tasks.map((t) => t.priority))].sort((a, b) => b - a);
    for (const p of priorities) {
      groups.push({
        key: String(p),
        label: priorityLabel(p),
        tasks: sortTasks(tasks.filter((t) => t.priority === p)),
      });
    }
  }
  return groups;
}

const KEY_TO_ACTION: Record<string, TaskContextAction> = {
  s: "status",
  p: "priority",
  a: "assignee",
  c: "comment",
};

// Documented in the "?" help popover (PRD §1.4 keyboard map).
const SHORTCUTS: Array<{ keys: string; what: string }> = [
  { keys: "↑ / ↓", what: "Move row focus" },
  { keys: "Enter", what: "Open detail" },
  { keys: "x", what: "Toggle select" },
  { keys: "s", what: "Set status" },
  { keys: "p", what: "Set priority" },
  { keys: "a", what: "Assign" },
  { keys: "c", what: "Comment" },
  { keys: "/", what: "Focus quick-add" },
  { keys: "Cmd/Ctrl+K", what: "Command palette" },
  { keys: "?", what: "This help" },
];

function rowDomId(id: string): string {
  return `kanban-row-${id}`;
}

function isEditableTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.tagName === "INPUT" ||
      t.tagName === "TEXTAREA" ||
      t.tagName === "SELECT" ||
      t.isContentEditable)
  );
}

export default function KanbanListView({
  onOpenBoard,
  refreshNonce,
  groupBy,
  onGroupByChange,
  requestedTaskId,
  onRequestedTaskHandled,
  onTaskAction,
  onFocusQuickAdd,
  hotkeysEnabled,
  filter,
  meta,
  onPatchMeta,
  onBoardLoaded,
}: {
  onOpenBoard: () => void;
  /** Bumped by the parent after out-of-view mutations (quick-add, palette)
   *  to force a refetch without the list owning that plumbing. */
  refreshNonce: number;
  /** Lifted so the command palette's "Group by …" can drive it (PRD §1.4). */
  groupBy: GroupBy;
  onGroupByChange: (groupBy: GroupBy) => void;
  /** Palette task pick → open this task's detail panel, then ack. */
  requestedTaskId: string | null;
  onRequestedTaskHandled: () => void;
  /** Row hotkeys s/p/a/c — parent opens the palette in task context. */
  onTaskAction: (task: KanbanTask, action: TaskContextAction) => void;
  /** "/" hotkey — parent focuses the quick-add bar. */
  onFocusQuickAdd: () => void;
  /** Parent disables row hotkeys while the palette overlay is open. */
  hotkeysEnabled: boolean;
  /** Active FilterState (chips + saved views live in the parent). */
  filter: KanbanFilterState;
  /** Sidecar meta (due dates etc.); null while loading — the list still
   *  renders, sidecar-driven filters/badges just stay inert. */
  meta: KanbanMeta | null;
  /** Detail-panel sidecar edits (due date / labels / estimate / cycle) —
   *  parent owns the PATCH + toast + meta fold-back. */
  onPatchMeta: (taskId: string, patch: KanbanTaskMetaPatch) => void;
  /** Live board tasks after every fetch — drives the parent's lazy sidecar
   *  prune (PRD §2.2) and the per-cycle progress rollup (PRD §3.3). Latched
   *  in a ref internally, so callers may pass an unstable reference without
   *  resetting the poll timer. */
  onBoardLoaded: (tasks: KanbanTask[]) => void;
}) {
  const { toast, showToast } = useToast();
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // onBoardLoaded rides a ref so `load` (and the polling effect depending
  // on it) keeps a stable identity: a parent passing a fresh callback per
  // render would otherwise tear down and restart the 30s timer on every
  // board fetch, effectively disabling the poll.
  const onBoardLoadedRef = useRef(onBoardLoaded);
  useEffect(() => {
    onBoardLoadedRef.current = onBoardLoaded;
  }, [onBoardLoaded]);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const b = await api.getKanbanBoard();
      setBoard(b);
      setError(null);
      onBoardLoadedRef.current(b.columns.flatMap((c) => c.tasks));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  // Initial fetch + 30s polling; every mutation below also refetches. The
  // plugin's WS /events live-refresh channel is deliberately skipped in v1
  // (PRD §1.2) — future work.
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
    // refreshNonce re-runs the fetch (and harmlessly resets the poll timer).
  }, [load, refreshNonce]);

  const tasks = useMemo(
    () => (board ? board.columns.flatMap((c) => c.tasks) : []),
    [board],
  );
  const filteredTasks = useMemo(
    () => applyFilter(tasks, filter, meta),
    [tasks, filter, meta],
  );
  const groups = useMemo(
    () => groupTasks(filteredTasks, groupBy),
    [filteredTasks, groupBy],
  );
  // Flattened visible order for ↑/↓ row focus.
  const flatTasks = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);
  // id → label for row chips / detail (sidecar labels store ids only).
  const labelById = useMemo(
    () => new Map((meta?.labels ?? []).map((l) => [l.id, l])),
    [meta],
  );
  const taskLabels = useCallback(
    (id: string): KanbanLabel[] =>
      (meta?.tasks[id]?.labels ?? []).flatMap((lid) => {
        const l = labelById.get(lid);
        return l ? [l] : [];
      }),
    [labelById, meta],
  );
  const assignees = board?.assignees ?? [];
  const detail =
    detailId != null ? (tasks.find((t) => t.id === detailId) ?? null) : null;

  const closeDetail = useCallback(() => setDetailId(null), []);
  const panelRef = useModalBehavior({ open: detail != null, onClose: closeDetail });

  const patchTask = useCallback(
    async (id: string, body: KanbanUpdateTaskBody) => {
      try {
        await api.updateKanbanTask(id, body);
        showToast("Saved ✓", "success");
      } catch (e: unknown) {
        showToast(
          `Update failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      } finally {
        void load();
      }
    },
    [load, showToast],
  );

  const bulkApply = useCallback(
    async (patch: Omit<KanbanBulkUpdateBody, "ids">) => {
      const ids = [...selected];
      if (!ids.length) return;
      try {
        const res = await api.bulkUpdateKanbanTasks({ ids, ...patch });
        const failed = res.results.filter((r) => !r.ok);
        if (failed.length) {
          // Partial failures keep the selection so the operator can retry.
          showToast(
            `${failed.length}/${ids.length} failed: ${failed[0].error ?? "unknown error"}`,
            "error",
          );
        } else {
          showToast(`Updated ${ids.length} task${ids.length === 1 ? "" : "s"} ✓`, "success");
          setSelected(new Set());
        }
      } catch (e: unknown) {
        showToast(
          `Bulk update failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      } finally {
        void load();
      }
    },
    [load, selected, showToast],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const openTask = useCallback((id: string) => {
    setFocusedId(id);
    setDetailId(id);
  }, []);

  // External detail-open requests (palette task pick / "Open detail").
  useEffect(() => {
    if (requestedTaskId == null) return;
    openTask(requestedTaskId);
    onRequestedTaskHandled();
  }, [requestedTaskId, onRequestedTaskHandled, openTask]);

  // Row keyboard map (PRD §1.4). One window listener while the list is
  // mounted, removed on cleanup — no global leaks. It yields whenever a
  // modal layer owns the keyboard (detail panel; palette via
  // `hotkeysEnabled`) or focus sits in a form field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hotkeysEnabled || detailId != null) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (helpOpen) {
        if (e.key === "Escape") setHelpOpen(false);
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        onFocusQuickAdd();
        return;
      }
      if (!flatTasks.length) return;
      const idx =
        focusedId != null ? flatTasks.findIndex((t) => t.id === focusedId) : -1;
      const focused = idx >= 0 ? flatTasks[idx] : null;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const nextIdx =
          e.key === "ArrowDown"
            ? Math.min(idx + 1, flatTasks.length - 1)
            : Math.max(idx - 1, 0);
        const next = flatTasks[nextIdx];
        setFocusedId(next.id);
        document
          .getElementById(rowDomId(next.id))
          ?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (!focused) return;
      if (e.key === "Enter") {
        e.preventDefault();
        openTask(focused.id);
      } else if (e.key === "x") {
        e.preventDefault();
        toggleSelect(focused.id);
      } else if (e.key in KEY_TO_ACTION) {
        e.preventDefault();
        onTaskAction(focused, KEY_TO_ACTION[e.key]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    detailId,
    flatTasks,
    focusedId,
    helpOpen,
    hotkeysEnabled,
    onFocusQuickAdd,
    onTaskAction,
    openTask,
    toggleSelect,
  ]);

  if (error && !board) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            Couldn't load the board: {error}
          </p>
          <Button size="sm" className="uppercase" onClick={() => void load(true)}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!board) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Toast toast={toast} />

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="kanban-group-by" className="text-xs text-muted-foreground">
          Group by
        </Label>
        <Select
          id="kanban-group-by"
          className="w-36"
          value={groupBy}
          onValueChange={(v) => onGroupByChange(v as GroupBy)}
          aria-label="Group tasks by"
        >
          <SelectOption value="status">Status</SelectOption>
          <SelectOption value="assignee">Assignee</SelectOption>
          <SelectOption value="priority">Priority</SelectOption>
        </Select>
        <Button
          type="button"
          ghost
          size="icon"
          aria-label="Refresh tasks"
          onClick={() => void load(true)}
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </Button>
        <span className="text-xs text-muted-foreground">
          {filteredTasks.length === tasks.length
            ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}`
            : `${filteredTasks.length} of ${tasks.length} tasks`}
        </span>
        <div className="relative ml-auto">
          <Button
            type="button"
            ghost
            size="icon"
            aria-label="Keyboard shortcuts"
            onClick={() => setHelpOpen((v) => !v)}
          >
            <CircleHelp className="h-4 w-4" />
          </Button>
          {helpOpen && (
            <div
              role="dialog"
              aria-label="Keyboard shortcuts"
              className="absolute right-0 z-50 mt-1 w-64 rounded-md border border-border bg-card p-3 shadow-xl"
            >
              <div className="flex items-center justify-between pb-2">
                <span className="text-xs font-medium uppercase text-muted-foreground">
                  Keyboard
                </span>
                <Button
                  ghost
                  size="icon"
                  aria-label="Close shortcuts"
                  onClick={() => setHelpOpen(false)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              <ul className="flex flex-col gap-1 text-xs">
                {SHORTCUTS.map((sc) => (
                  <li
                    key={sc.what}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="text-muted-foreground">{sc.what}</span>
                    <kbd className="rounded border border-border bg-midground/10 px-1 font-mono text-[10px]">
                      {sc.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          assignees={assignees}
          onApply={(patch) => void bulkApply(patch)}
          onClear={() => setSelected(new Set())}
        />
      )}

      {filteredTasks.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {tasks.length === 0
              ? "No tasks on the board yet. Switch to Board view to create one."
              : "No tasks match the current filters."}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => {
            // Summed estimate points in the group header (PRD §3.2 — total
            // only; unestimated tasks count 0, a zero sum renders nothing).
            const points = g.tasks.reduce(
              (sum, t) => sum + (meta?.tasks[t.id]?.estimate ?? 0),
              0,
            );
            return (
              <section key={g.key} aria-label={`${g.label} tasks`}>
                <header className="flex items-center gap-2 px-1 pb-1">
                  <span className="text-sm font-medium capitalize">{g.label}</span>
                  <span className="text-xs text-muted-foreground">{g.tasks.length}</span>
                  {points > 0 && (
                    <span className="text-xs text-muted-foreground">
                      · {points} pts
                    </span>
                  )}
                </header>
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                  {g.tasks.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      dueAt={meta?.tasks[t.id]?.due_at ?? null}
                      labels={taskLabels(t.id)}
                      estimate={meta?.tasks[t.id]?.estimate ?? null}
                      groupBy={groupBy}
                      selected={selected.has(t.id)}
                      focused={focusedId === t.id}
                      onToggleSelect={toggleSelect}
                      onOpen={openTask}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {detail && (
        <DetailPanel
          task={detail}
          taskMeta={meta?.tasks[detail.id] ?? null}
          allLabels={meta?.labels ?? []}
          cycles={meta?.cycles ?? []}
          assignees={assignees}
          panelRef={panelRef}
          onClose={closeDetail}
          onPatch={(id, body) => void patchTask(id, body)}
          onPatchMeta={onPatchMeta}
          onOpenBoard={onOpenBoard}
        />
      )}
    </div>
  );
}

function BulkBar({
  count,
  assignees,
  onApply,
  onClear,
}: {
  count: number;
  assignees: string[];
  onApply: (patch: Omit<KanbanBulkUpdateBody, "ids">) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
      <span className="text-sm font-medium">
        {count} selected
      </span>
      <Select
        className="w-36"
        value=""
        placeholder="Set status…"
        aria-label="Set status for selected tasks"
        onValueChange={(v) => v && onApply({ status: v })}
      >
        {BULK_STATUSES.map((s) => (
          <SelectOption key={s} value={s}>
            {s}
          </SelectOption>
        ))}
      </Select>
      <Select
        className="w-36"
        value=""
        placeholder="Set priority…"
        aria-label="Set priority for selected tasks"
        onValueChange={(v) => v !== "" && onApply({ priority: Number(v) })}
      >
        {PRIORITY_OPTIONS.map((o) => (
          <SelectOption key={o.value} value={String(o.value)}>
            {o.label}
          </SelectOption>
        ))}
      </Select>
      <Select
        className="w-40"
        value=""
        placeholder="Assign to…"
        aria-label="Assign selected tasks"
        onValueChange={(v) =>
          v && onApply({ assignee: v === UNASSIGN_SENTINEL ? "" : v })
        }
      >
        <SelectOption value={UNASSIGN_SENTINEL}>Unassigned</SelectOption>
        {assignees.map((a) => (
          <SelectOption key={a} value={a}>
            {a}
          </SelectOption>
        ))}
      </Select>
      <Button type="button" ghost size="sm" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}

function TaskRow({
  task,
  dueAt,
  labels,
  estimate,
  groupBy,
  selected,
  focused,
  onToggleSelect,
  onOpen,
}: {
  task: KanbanTask;
  /** Sidecar due date (ISO date) — null when unset or meta not loaded. */
  dueAt: string | null;
  /** Resolved sidecar labels for the row chips (PRD §3.1). */
  labels: KanbanLabel[];
  /** Sidecar estimate points — null when unset (PRD §3.2). */
  estimate: number | null;
  groupBy: GroupBy;
  selected: boolean;
  /** Keyboard row focus (↑/↓) — visual ring only, separate from selection. */
  focused: boolean;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <li id={rowDomId(task.id)}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(task.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpen(task.id);
        }}
        className={cn(
          "flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-midground/5",
          selected && "bg-midground/8",
          focused && "ring-1 ring-inset ring-brand",
        )}
      >
        {/* Checkbox clicks must not open the detail panel. */}
        <span className="flex items-center" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect(task.id)}
            aria-label={`Select ${task.title}`}
          />
        </span>
        <Badge tone={priorityTone(task.priority)} className="shrink-0">
          {priorityLabel(task.priority)}
        </Badge>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {shortId(task.id)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
        {labels.map((l) => (
          <LabelChip key={l.id} label={l} />
        ))}
        {dueAt && <DueBadge dueAt={dueAt} />}
        {groupBy !== "status" && (
          <Badge tone="outline" className="shrink-0">
            {task.status}
          </Badge>
        )}
        {task.assignee && (
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {task.assignee}
          </span>
        )}
        {(task.comment_count ?? 0) > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <MessageSquare className="h-3 w-3" />
            {task.comment_count}
          </span>
        )}
        {estimate != null && (
          <span
            className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground"
            title={`${estimate} point${estimate === 1 ? "" : "s"}`}
          >
            {estimate}
          </span>
        )}
        <span className="w-10 shrink-0 text-right text-xs text-muted-foreground">
          {fmtAge(taskAgeSeconds(task))}
        </span>
      </div>
    </li>
  );
}

// Due-date editor (PRD §2.2): same local-draft + commit-on-blur/Enter
// pattern as EstimateInput below. Typed entry in a date input fires
// onChange per segment with partial values ("" / incomplete dates), each of
// which would otherwise become a PATCH the server's _valid_iso_date 400s.
// Empty commits a clear; anything not a full YYYY-MM-DD snaps back.
function DueDateInput({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);
  const commit = () => {
    if (!draft) {
      if (value != null) onCommit(null);
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft)) {
      setDraft(value ?? "");
      return;
    }
    if (draft !== value) onCommit(draft);
  };
  return (
    <Input
      id="kanban-detail-due"
      type="date"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      aria-label="Due date"
    />
  );
}

// Estimate points editor (PRD §3.2): local draft committed on blur/Enter so
// every keystroke isn't a PATCH. Empty clears; non-int or out-of-range
// (0–100, the server's bounds) snaps back to the stored value.
function EstimateInput({
  value,
  onCommit,
}: {
  value: number | null;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => {
    setDraft(value == null ? "" : String(value));
  }, [value]);
  const commit = () => {
    const t = draft.trim();
    if (!t) {
      if (value != null) onCommit(null);
      return;
    }
    const n = Number(t);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      setDraft(value == null ? "" : String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <Input
      id="kanban-detail-estimate"
      type="number"
      min={0}
      max={100}
      step={1}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      aria-label="Estimate points"
    />
  );
}

// Row/detail label chip: colored palette dot + name (PRD §3.1).
function LabelChip({ label }: { label: KanbanLabel }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: label.color }}
      />
      {label.name}
    </span>
  );
}

function DetailPanel({
  task,
  taskMeta,
  allLabels,
  cycles,
  assignees,
  panelRef,
  onClose,
  onPatch,
  onPatchMeta,
  onOpenBoard,
}: {
  task: KanbanTask;
  /** The task's sidecar entry — null when unset or meta not loaded. */
  taskMeta: KanbanTaskMeta | null;
  /** Every defined label (multi-assign toggles, PRD §3.1). */
  allLabels: KanbanLabel[];
  /** Every defined cycle (assignment select, PRD §3.3). */
  cycles: KanbanCycle[];
  assignees: string[];
  panelRef: ReturnType<typeof useModalBehavior>;
  onClose: () => void;
  onPatch: (id: string, body: KanbanUpdateTaskBody) => void;
  onPatchMeta: (taskId: string, patch: KanbanTaskMetaPatch) => void;
  onOpenBoard: () => void;
}) {
  const dueAt = taskMeta?.due_at ?? null;
  const assignedLabels = taskMeta?.labels ?? [];
  // Prepend the current status / priority / assignee when they fall outside
  // the editable sets (running, review, out-of-ladder ints, retired
  // assignees) so the selects never render blank.
  const statusOptions = SETTABLE_STATUSES.includes(task.status)
    ? SETTABLE_STATUSES
    : [task.status, ...SETTABLE_STATUSES];
  const priorityOptions = PRIORITY_OPTIONS.some((o) => o.value === task.priority)
    ? PRIORITY_OPTIONS
    : [{ value: task.priority, label: priorityLabel(task.priority) }, ...PRIORITY_OPTIONS];
  const assigneeOptions =
    task.assignee && !assignees.includes(task.assignee)
      ? [task.assignee, ...assignees]
      : assignees;

  return (
    <div
      ref={panelRef}
      className="fixed inset-0 z-[100] flex justify-end bg-background/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={`Task ${shortId(task.id)}`}
    >
      <div className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-card shadow-2xl">
        <header className="flex items-center justify-between gap-2 border-b border-border p-4">
          <span className="truncate font-mono text-xs text-muted-foreground">
            {task.id}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              ghost
              size="sm"
              onClick={() => {
                onClose();
                onOpenBoard();
              }}
              prefix={<ExternalLink className="h-3.5 w-3.5" />}
            >
              Board view
            </Button>
            <Button ghost size="icon" onClick={onClose} aria-label="Close">
              <X />
            </Button>
          </div>
        </header>

        <div className="flex flex-col gap-4 p-4">
          <h2 className="text-base font-semibold leading-snug">{task.title}</h2>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="outline">{task.status}</Badge>
            <Badge tone={priorityTone(task.priority)}>
              {priorityLabel(task.priority)}
            </Badge>
            {task.tenant && <Badge tone="secondary">{task.tenant}</Badge>}
            {dueAt && <DueBadge dueAt={dueAt} />}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="kanban-detail-status">Status</Label>
              <Select
                id="kanban-detail-status"
                value={task.status}
                onValueChange={(v) => {
                  if (v !== task.status) onPatch(task.id, { status: v });
                }}
              >
                {statusOptions.map((s) => (
                  <SelectOption key={s} value={s}>
                    {s}
                  </SelectOption>
                ))}
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="kanban-detail-priority">Priority</Label>
              <Select
                id="kanban-detail-priority"
                value={String(task.priority)}
                onValueChange={(v) => {
                  if (Number(v) !== task.priority) {
                    onPatch(task.id, { priority: Number(v) });
                  }
                }}
              >
                {priorityOptions.map((o) => (
                  <SelectOption key={o.value} value={String(o.value)}>
                    {o.label}
                  </SelectOption>
                ))}
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="kanban-detail-assignee">Assignee</Label>
              <Select
                id="kanban-detail-assignee"
                value={task.assignee ?? ""}
                onValueChange={(v) => {
                  // "" unassigns (the PATCH endpoint maps "" to NULL).
                  if (v !== (task.assignee ?? "")) {
                    onPatch(task.id, { assignee: v });
                  }
                }}
              >
                <SelectOption value="">Unassigned</SelectOption>
                {assigneeOptions.map((a) => (
                  <SelectOption key={a} value={a}>
                    {a}
                  </SelectOption>
                ))}
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="kanban-detail-due">Due date</Label>
              <div className="flex items-center gap-1">
                <DueDateInput
                  value={dueAt}
                  onCommit={(v) => onPatchMeta(task.id, { due_at: v })}
                />
                {dueAt && (
                  <Button
                    type="button"
                    ghost
                    size="icon"
                    aria-label="Clear due date"
                    onClick={() => onPatchMeta(task.id, { due_at: null })}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="kanban-detail-estimate">Estimate (points)</Label>
              <EstimateInput
                value={taskMeta?.estimate ?? null}
                onCommit={(v) => onPatchMeta(task.id, { estimate: v })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="kanban-detail-cycle">Cycle</Label>
              <Select
                id="kanban-detail-cycle"
                value={taskMeta?.cycle_id ?? ""}
                onValueChange={(v) => {
                  // "" clears (sidecar PATCH maps null to "remove field").
                  if (v !== (taskMeta?.cycle_id ?? "")) {
                    onPatchMeta(task.id, { cycle_id: v || null });
                  }
                }}
              >
                <SelectOption value="">No cycle</SelectOption>
                {cycles.map((c) => (
                  <SelectOption key={c.id} value={c.id}>
                    {c.name}
                  </SelectOption>
                ))}
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <span className="text-sm font-medium">Labels</span>
            {allLabels.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No labels defined — manage them from the filter bar.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {allLabels.map((l) => {
                  const active = assignedLabels.includes(l.id);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() =>
                        onPatchMeta(task.id, {
                          labels: active
                            ? assignedLabels.filter((id) => id !== l.id)
                            : [...assignedLabels, l.id],
                        })
                      }
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
                        active
                          ? "border-brand text-foreground"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: l.color }}
                      />
                      {l.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <dt>Created</dt>
            <dd className="text-right">
              {fmtAge(task.age?.created_age_seconds)} ago
            </dd>
            {task.age?.started_age_seconds != null && (
              <>
                <dt>Started</dt>
                <dd className="text-right">
                  {fmtAge(task.age.started_age_seconds)} ago
                </dd>
              </>
            )}
            <dt>Comments</dt>
            <dd className="text-right">{task.comment_count ?? 0}</dd>
          </dl>

          {task.latest_summary && (
            <section className="grid gap-1">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">
                Latest summary
              </h3>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {task.latest_summary}
              </p>
            </section>
          )}

          {task.body && (
            <section className="grid gap-1">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">
                Description
              </h3>
              <p className="whitespace-pre-wrap text-sm">{task.body}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
