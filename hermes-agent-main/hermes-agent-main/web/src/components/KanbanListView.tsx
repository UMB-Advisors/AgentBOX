import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, MessageSquare, RefreshCw, X } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Checkbox } from "@nous-research/ui/ui/components/checkbox";
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
  type KanbanTask,
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

type GroupBy = "status" | "assignee" | "priority";

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

// Statuses PATCH /tasks/:id accepts as a target. "running" is dispatcher-
// owned and "review" has no transition verb (the plugin API 400s on both),
// so neither is offered as an edit target — tasks already in them still
// render, and their current status is prepended so the select isn't blank.
const SETTABLE_STATUSES = [
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

const PRIORITY_OPTIONS: Array<{ value: number; label: string }> = [
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

function priorityLabel(p: number): string {
  return PRIORITY_OPTIONS.find((o) => o.value === p)?.label ?? `P${p}`;
}

function priorityTone(p: number): "warning" | "secondary" | "outline" {
  if (p >= 3) return "warning";
  if (p === 2) return "secondary";
  return "outline";
}

function shortId(id: string): string {
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

export default function KanbanListView({ onOpenBoard }: { onOpenBoard: () => void }) {
  const { toast, showToast } = useToast();
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>("status");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      setBoard(await api.getKanbanBoard());
      setError(null);
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
  }, [load]);

  const tasks = useMemo(
    () => (board ? board.columns.flatMap((c) => c.tasks) : []),
    [board],
  );
  const groups = useMemo(() => groupTasks(tasks, groupBy), [tasks, groupBy]);
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
          onValueChange={(v) => setGroupBy(v as GroupBy)}
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
          {tasks.length} task{tasks.length === 1 ? "" : "s"}
        </span>
      </div>

      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          assignees={assignees}
          onApply={(patch) => void bulkApply(patch)}
          onClear={() => setSelected(new Set())}
        />
      )}

      {tasks.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No tasks on the board yet. Switch to Board view to create one.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <section key={g.key} aria-label={`${g.label} tasks`}>
              <header className="flex items-center gap-2 px-1 pb-1">
                <span className="text-sm font-medium capitalize">{g.label}</span>
                <span className="text-xs text-muted-foreground">{g.tasks.length}</span>
              </header>
              <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {g.tasks.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    groupBy={groupBy}
                    selected={selected.has(t.id)}
                    onToggleSelect={toggleSelect}
                    onOpen={setDetailId}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {detail && (
        <DetailPanel
          task={detail}
          assignees={assignees}
          panelRef={panelRef}
          onClose={closeDetail}
          onPatch={(id, body) => void patchTask(id, body)}
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
  groupBy,
  selected,
  onToggleSelect,
  onOpen,
}: {
  task: KanbanTask;
  groupBy: GroupBy;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <li>
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
        <span className="w-10 shrink-0 text-right text-xs text-muted-foreground">
          {fmtAge(taskAgeSeconds(task))}
        </span>
      </div>
    </li>
  );
}

function DetailPanel({
  task,
  assignees,
  panelRef,
  onClose,
  onPatch,
  onOpenBoard,
}: {
  task: KanbanTask;
  assignees: string[];
  panelRef: ReturnType<typeof useModalBehavior>;
  onClose: () => void;
  onPatch: (id: string, body: KanbanUpdateTaskBody) => void;
  onOpenBoard: () => void;
}) {
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
