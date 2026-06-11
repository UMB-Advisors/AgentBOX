import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, KeyRound, RefreshCw } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { Link } from "react-router-dom";
import { PluginPage } from "@/plugins";
import CommandPalette, { type PaletteCommand } from "@/components/CommandPalette";
import KanbanFilterBar, {
  EMPTY_FILTER,
  makeLabel,
  type KanbanCycleProgress,
} from "@/components/KanbanFilterBar";
import KanbanListView, {
  type GroupBy,
  type TaskContextAction,
} from "@/components/KanbanListView";
import { cn } from "@/lib/utils";
import { parseQuickAdd } from "@/lib/quickAdd";
import {
  api,
  type KanbanCycle,
  type KanbanFilterState,
  type KanbanLabel,
  type KanbanMeta,
  type KanbanSavedView,
  type KanbanTask,
  type KanbanTaskMetaPatch,
  type LinearBoard,
  type LinearTeam,
  type TaskProviderId,
  type TasksPrefs,
} from "@/lib/api";

// Org Chart > Tasks with a selectable provider: the native /kanban plugin
// (default) or a read-only Linear board. The preference persists server-side
// (~/.hermes/tasks-prefs.json) so it survives reloads and the kiosk.
// See docs/orgchart-tasks-provider.v0.1.0.md.

const PROVIDERS: Array<{ id: TaskProviderId; label: string }> = [
  { id: "native", label: "Native" },
  { id: "linear", label: "Linear" },
];

// Native sub-views (docs/kanban-linear-ux.v0.1.0.md §1.1): Board = the stock
// kanban plugin embed (unchanged), List = our KanbanListView. UI-only state,
// persisted in localStorage per the PRD (no backend round-trip).
type NativeSubView = "board" | "list";

const SUBVIEWS: Array<{ id: NativeSubView; label: string }> = [
  { id: "board", label: "Board" },
  { id: "list", label: "List" },
];

const SUBVIEW_STORAGE_KEY = "hermes.orgTasks.nativeSubView";

function readStoredSubView(): NativeSubView {
  try {
    return localStorage.getItem(SUBVIEW_STORAGE_KEY) === "list" ? "list" : "board";
  } catch {
    // Storage unavailable (kiosk private mode etc.) — default to Board.
    return "board";
  }
}

// Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
const PRIORITY_LABELS: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export default function OrgTasks({ kanbanName }: { kanbanName: string | null }) {
  const [prefs, setPrefs] = useState<TasksPrefs | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getTasksPrefs()
      .then((p) => alive && setPrefs(p))
      .catch(() => {
        // Prefs endpoint unavailable (e.g. stale backend): fall back to native.
        if (alive) {
          setPrefs({
            provider: "native",
            linear_team_id: null,
            linear_configured: false,
          });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const setProvider = useCallback((provider: TaskProviderId) => {
    setPrefs((p) => (p ? { ...p, provider } : p));
    api.setTasksPrefs({ provider }).then(setPrefs).catch(() => {});
  }, []);

  const setTeam = useCallback((linear_team_id: string) => {
    setPrefs((p) => (p ? { ...p, linear_team_id: linear_team_id || null } : p));
    api.setTasksPrefs({ linear_team_id }).then(setPrefs).catch(() => {});
  }, []);

  if (!prefs) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        className="inline-flex w-fit items-center gap-1 rounded-md border border-border p-1"
        role="radiogroup"
        aria-label="Task provider"
      >
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={prefs.provider === p.id}
            onClick={() => setProvider(p.id)}
            className={cn(
              "rounded px-3 py-1 text-sm font-medium transition-colors",
              prefs.provider === p.id
                ? "bg-brand text-brand-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {prefs.provider === "native" ? (
        kanbanName ? (
          <NativeTasks kanbanName={kanbanName} />
        ) : (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              The native Tasks board needs the kanban plugin, which isn't
              installed on this box. Switch to Linear above, or install the
              plugin.
            </CardContent>
          </Card>
        )
      ) : (
        <LinearTasksView
          teamId={prefs.linear_team_id}
          configured={prefs.linear_configured}
          onTeamChange={setTeam}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Native provider: sub-view toggle + quick-add bar (PRD §1.1/§1.3).
// ---------------------------------------------------------------------------

// The UI-kit Input doesn't forward refs, so quick-add focus requests go
// through a stable DOM id instead.
const QUICK_ADD_INPUT_ID = "kanban-quick-add-input";

interface PaletteState {
  open: boolean;
  /** Non-null = the palette opened in this task's context (row hotkeys). */
  task: KanbanTask | null;
  action: TaskContextAction | null;
}

const PALETTE_CLOSED: PaletteState = { open: false, task: null, action: null };

function NativeTasks({ kanbanName }: { kanbanName: string }) {
  const { toast, showToast } = useToast();
  const [subView, setSubView] = useState<NativeSubView>(readStoredSubView);
  // Bumped after every mutation made outside KanbanListView (quick-add)
  // so the list refetches without owning that plumbing itself.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [assigneeNames, setAssigneeNames] = useState<string[]>([]);
  // Group-by lives here (not in the list) so the palette can drive it.
  const [groupBy, setGroupBy] = useState<GroupBy>("status");
  const [requestedTaskId, setRequestedTaskId] = useState<string | null>(null);
  const [palette, setPalette] = useState<PaletteState>(PALETTE_CLOSED);
  const [paletteTasks, setPaletteTasks] = useState<KanbanTask[]>([]);
  // Sidecar meta doc (due dates, saved views, …) + the active FilterState
  // (PRD §2.1/§2.2). activeViewId is a built-in chip id or a saved-view id;
  // null = ad-hoc filter with no view selected.
  const [meta, setMeta] = useState<KanbanMeta | null>(null);
  const [filter, setFilter] = useState<KanbanFilterState>(EMPTY_FILTER);
  const [activeViewId, setActiveViewId] = useState<string | null>("all");

  const selectSubView = useCallback((v: NativeSubView) => {
    setSubView(v);
    try {
      localStorage.setItem(SUBVIEW_STORAGE_KEY, v);
    } catch {
      // Persistence is best-effort; the toggle still works for the session.
    }
  }, []);

  const bumpRefresh = useCallback(() => setRefreshNonce((n) => n + 1), []);

  // Sidecar meta load — refetched with the board (refreshNonce) so due
  // dates / views edited elsewhere stay current. Failure leaves meta null:
  // the list renders fine, sidecar-driven UI just stays inert.
  useEffect(() => {
    let alive = true;
    api
      .getKanbanMeta()
      .then((m) => alive && setMeta(m))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [refreshNonce]);

  // Detail-panel sidecar edits (due date / labels / estimate / cycle — PRD
  // §2.2/§3): PATCH the task's sidecar entry, then fold the server's
  // canonical entry back into local meta so badges, chips, and filters
  // update without waiting for the next refetch.
  const patchTaskMeta = useCallback(
    (taskId: string, patch: KanbanTaskMetaPatch) => {
      void api
        .patchKanbanTaskMeta(taskId, patch)
        .then((entry) => {
          setMeta((m) => {
            if (!m) return m;
            const tasks = { ...m.tasks };
            if (Object.keys(entry).length) tasks[taskId] = entry;
            else delete tasks[taskId];
            return { ...m, tasks };
          });
        })
        .catch((e: unknown) => {
          showToast(
            `Saving task metadata failed: ${e instanceof Error ? e.message : String(e)}`,
            "error",
          );
        });
    },
    [showToast],
  );

  // Live board tasks as last reported by the list (statuses + estimates
  // feed the per-cycle progress rollup, PRD §3.3).
  const [boardTasks, setBoardTasks] = useState<KanbanTask[]>([]);

  // Lazy sidecar GC (PRD §2.2): after each board fetch the list reports the
  // live tasks; when the sidecar still holds entries for ids gone from
  // the board (deleted or archived — archived tasks shedding their meta is
  // accepted, see the server docstring), one PUT with prune_missing drops
  // them server-side. Refs keep the callback referentially stable (the
  // list's fetch effect depends on it) and gate to one prune in flight.
  // Best-effort: a failed or raced prune just retries on the next fetch.
  const metaRef = useRef<KanbanMeta | null>(null);
  useEffect(() => {
    metaRef.current = meta;
  }, [meta]);
  const pruneInFlight = useRef(false);
  const handleBoardLoaded = useCallback((tasks: KanbanTask[]) => {
    setBoardTasks(tasks);
    const m = metaRef.current;
    if (!m || pruneInFlight.current) return;
    const liveIds = tasks.map((t) => t.id);
    const live = new Set(liveIds);
    if (!Object.keys(m.tasks).some((id) => !live.has(id))) return;
    pruneInFlight.current = true;
    api
      .putKanbanMeta({ prune_missing: true, live_task_ids: liveIds })
      .then((updated) => setMeta(updated))
      .catch(() => {
        // Stale entries are harmless; the next board fetch retries.
      })
      .finally(() => {
        pruneInFlight.current = false;
      });
  }, []);

  // Per-cycle progress (PRD §3.3): done = status "done"; unestimated tasks
  // count 0 points. The board payload excludes archived tasks, so archived
  // work drops out of the rollup (consistent with the prune above).
  const cycleProgress = useMemo<Record<string, KanbanCycleProgress>>(() => {
    const out: Record<string, KanbanCycleProgress> = {};
    if (!meta) return out;
    for (const c of meta.cycles) {
      out[c.id] = { doneTasks: 0, totalTasks: 0, donePoints: 0, totalPoints: 0 };
    }
    for (const t of boardTasks) {
      const tm = meta.tasks[t.id];
      const cid = tm?.cycle_id;
      if (cid == null || !(cid in out)) continue;
      const pts = tm?.estimate ?? 0;
      out[cid].totalTasks += 1;
      out[cid].totalPoints += pts;
      if (t.status === "done") {
        out[cid].doneTasks += 1;
        out[cid].donePoints += pts;
      }
    }
    return out;
  }, [boardTasks, meta]);

  const selectView = useCallback((id: string, filters: KanbanFilterState) => {
    setActiveViewId(id);
    // Copy the arrays so ad-hoc edits never mutate the stored view.
    setFilter({
      ...filters,
      statuses: [...filters.statuses],
      assignees: [...filters.assignees],
      tenants: [...filters.tenants],
      labels: [...filters.labels],
    });
  }, []);

  const putViews = useCallback(
    async (views: KanbanSavedView[], okMessage: string) => {
      try {
        const updated = await api.putKanbanMeta({ views });
        setMeta(updated);
        showToast(okMessage, "success");
        return updated;
      } catch (e: unknown) {
        showToast(
          `Saving views failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
        return null;
      }
    },
    [showToast],
  );

  const saveView = useCallback(
    (name: string) => {
      // PUT /api/tasks/meta replaces the WHOLE views array, so never build
      // it from a null meta (load failed / still in flight) -- that would
      // clobber existing saved views with just this one.
      if (!meta) {
        showToast("Views not loaded yet — try again in a moment", "error");
        return;
      }
      const id = `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const views = [...meta.views, { id, name, filters: filter }];
      void putViews(views, `View "${name}" saved ✓`).then((updated) => {
        if (updated) setActiveViewId(id);
      });
    },
    [filter, meta, putViews, showToast],
  );

  const updateView = useCallback(
    (id: string) => {
      const views = (meta?.views ?? []).map((v) =>
        v.id === id ? { ...v, filters: filter } : v,
      );
      void putViews(views, "View updated ✓");
    },
    [filter, meta, putViews],
  );

  const deleteView = useCallback(
    (id: string) => {
      const views = (meta?.views ?? []).filter((v) => v.id !== id);
      void putViews(views, "View deleted ✓").then((updated) => {
        // Keep the (now ad-hoc) filter; just drop the chip highlight.
        if (updated) setActiveViewId((cur) => (cur === id ? null : cur));
      });
    },
    [meta, putViews],
  );

  // Label CRUD (PRD §3.1): full-array replace via PUT. The server scrubs
  // deleted ids off task entries; mirror that on the ACTIVE filter so a
  // deleted label doesn't keep silently hiding tasks.
  const saveLabels = useCallback(
    (labels: KanbanLabel[]) => {
      void (async () => {
        try {
          const updated = await api.putKanbanMeta({ labels });
          setMeta(updated);
          const ids = new Set(updated.labels.map((l) => l.id));
          setFilter((f) =>
            f.labels.every((id) => ids.has(id))
              ? f
              : { ...f, labels: f.labels.filter((id) => ids.has(id)) },
          );
          showToast("Labels saved ✓", "success");
        } catch (e: unknown) {
          showToast(
            `Saving labels failed: ${e instanceof Error ? e.message : String(e)}`,
            "error",
          );
        }
      })();
    },
    [showToast],
  );

  // Quick-add unknown-label create shortcut (PRD §3.1): append the missing
  // names (palette colors auto-rotate) and hand the updated doc back so the
  // bar can resubmit against it without waiting for a refetch.
  const createLabels = useCallback(
    async (names: string[]): Promise<KanbanMeta | null> => {
      const current = metaRef.current;
      if (!current) return null;
      const labels = [...current.labels];
      for (const name of names) labels.push(makeLabel(name, labels));
      try {
        const updated = await api.putKanbanMeta({ labels });
        setMeta(updated);
        showToast(
          `Label${names.length === 1 ? "" : "s"} created ✓`,
          "success",
        );
        return updated;
      } catch (e: unknown) {
        showToast(
          `Creating labels failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
        return null;
      }
    },
    [showToast],
  );

  // Cycle CRUD (PRD §3.3): full-array replace via PUT. The server scrubs a
  // deleted cycle off task entries; mirror that on the active filter.
  const saveCycles = useCallback(
    (cycles: KanbanCycle[]) => {
      void (async () => {
        try {
          const updated = await api.putKanbanMeta({ cycles });
          setMeta(updated);
          const ids = new Set(updated.cycles.map((c) => c.id));
          setFilter((f) =>
            f.cycleId != null && !ids.has(f.cycleId)
              ? { ...f, cycleId: null }
              : f,
          );
          showToast("Cycles saved ✓", "success");
        } catch (e: unknown) {
          showToast(
            `Saving cycles failed: ${e instanceof Error ? e.message : String(e)}`,
            "error",
          );
        }
      })();
    },
    [showToast],
  );

  // Known assignees for quick-add @validation (PRD §1.3). Re-fetched after
  // mutations so freshly-used names show up.
  useEffect(() => {
    let alive = true;
    api
      .getKanbanAssignees()
      .then((r) => alive && setAssigneeNames(r.assignees.map((a) => a.name)))
      .catch(() => {
        // Validation degrades gracefully — QuickAddBar skips the existence
        // check when the list is empty and lets the server decide.
      });
    return () => {
      alive = false;
    };
  }, [refreshNonce]);

  const openPalette = useCallback(
    (task: KanbanTask | null = null, action: TaskContextAction | null = null) => {
      setPalette({ open: true, task, action });
      // Fresh task list for the fuzzy search — fetched here because the
      // Board sub-view is an opaque plugin embed with no board we can read.
      api
        .getKanbanBoard()
        .then((b) => setPaletteTasks(b.columns.flatMap((c) => c.tasks)))
        .catch(() => {});
    },
    [],
  );

  const closePalette = useCallback(() => setPalette(PALETTE_CLOSED), []);

  // Cmd/Ctrl+K toggles the palette (PRD §1.4). Scoped to the Tasks tab by
  // construction: the listener mounts with NativeTasks and the cleanup
  // removes it on unmount — no global leak.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (palette.open) closePalette();
        else openPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette.open, openPalette, closePalette]);

  const focusQuickAdd = useCallback(() => {
    document.getElementById(QUICK_ADD_INPUT_ID)?.focus();
  }, []);

  // Palette task pick → the detail panel lives in the List view; switch
  // there if needed and let the list open it (smallest reading of PRD §1.4
  // "select → opens detail panel").
  const openTaskDetail = useCallback(
    (task: KanbanTask) => {
      selectSubView("list");
      setRequestedTaskId(task.id);
    },
    [selectSubView],
  );

  const handleRequestedTask = useCallback(() => setRequestedTaskId(null), []);

  // Row hotkeys s/p/a/c jump straight into the palette's task submenus.
  const handleTaskAction = useCallback(
    (task: KanbanTask, action: TaskContextAction) => openPalette(task, action),
    [openPalette],
  );

  const commands = useMemo<PaletteCommand[]>(
    () => [
      { id: "new-task", label: "New task", hint: "quick-add", run: focusQuickAdd },
      {
        id: "view-board",
        label: "Switch to Board view",
        run: () => selectSubView("board"),
      },
      {
        id: "view-list",
        label: "Switch to List view",
        run: () => selectSubView("list"),
      },
      // Grouping renders in the List view; switch over so it's visible.
      {
        id: "group-status",
        label: "Group by Status",
        run: () => {
          setGroupBy("status");
          selectSubView("list");
        },
      },
      {
        id: "group-assignee",
        label: "Group by Assignee",
        run: () => {
          setGroupBy("assignee");
          selectSubView("list");
        },
      },
      {
        id: "group-priority",
        label: "Group by Priority",
        run: () => {
          setGroupBy("priority");
          selectSubView("list");
        },
      },
      { id: "refresh", label: "Refresh tasks", run: bumpRefresh },
    ],
    [bumpRefresh, focusQuickAdd, selectSubView],
  );

  return (
    <div className="flex flex-col gap-3">
      <Toast toast={toast} />
      <div
        className="inline-flex w-fit items-center gap-1 rounded-md border border-border p-1"
        role="radiogroup"
        aria-label="Native tasks view"
      >
        {SUBVIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="radio"
            aria-checked={subView === v.id}
            onClick={() => selectSubView(v.id)}
            className={cn(
              "rounded px-3 py-1 text-sm font-medium transition-colors",
              subView === v.id
                ? "bg-brand text-brand-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <QuickAddBar
        assignees={assigneeNames}
        meta={meta}
        onCreateLabels={createLabels}
        showToast={showToast}
        onCreated={bumpRefresh}
      />

      {subView === "board" ? (
        <PluginPage name={kanbanName} />
      ) : (
        <>
          <KanbanFilterBar
            filter={filter}
            onFilterChange={(f) => setFilter(f)}
            views={meta?.views ?? []}
            activeViewId={activeViewId}
            onSelectView={selectView}
            onSaveView={saveView}
            onUpdateView={updateView}
            onDeleteView={deleteView}
            showOverdue={Object.values(meta?.tasks ?? {}).some(
              (t) => t.due_at != null,
            )}
            labels={meta?.labels ?? []}
            onSaveLabels={saveLabels}
            cycles={meta?.cycles ?? []}
            cycleProgress={cycleProgress}
            onSaveCycles={saveCycles}
          />
          <KanbanListView
            onOpenBoard={() => selectSubView("board")}
            refreshNonce={refreshNonce}
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
            requestedTaskId={requestedTaskId}
            onRequestedTaskHandled={handleRequestedTask}
            onTaskAction={handleTaskAction}
            onFocusQuickAdd={focusQuickAdd}
            hotkeysEnabled={!palette.open}
            filter={filter}
            meta={meta}
            onPatchMeta={patchTaskMeta}
            onBoardLoaded={handleBoardLoaded}
          />
        </>
      )}

      <CommandPalette
        open={palette.open}
        onClose={closePalette}
        commands={commands}
        tasks={paletteTasks}
        assignees={assigneeNames}
        initialTask={palette.task}
        initialAction={palette.action}
        meta={meta}
        onOpenTask={openTaskDetail}
        onMutated={bumpRefresh}
        notify={showToast}
      />
    </div>
  );
}

function QuickAddBar({
  assignees,
  meta,
  onCreateLabels,
  showToast,
  onCreated,
}: {
  assignees: string[];
  /** Sidecar doc for *label / cycle: token resolution; null while loading. */
  meta: KanbanMeta | null;
  /** Unknown-label create shortcut (PRD §3.1) — returns the updated doc. */
  onCreateLabels: (names: string[]) => Promise<KanbanMeta | null>;
  showToast: (message: string, type: "error" | "success") => void;
  onCreated: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Unknown *label names from the last submit — non-empty renders the
  // "create label" shortcut next to the inline error (PRD §3.1).
  const [unknownLabels, setUnknownLabels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // metaOverride lets the create-label shortcut resubmit against the doc the
  // PUT just returned, instead of waiting for the prop to catch up.
  const submit = useCallback(
    async (metaOverride?: KanbanMeta) => {
      const doc = metaOverride ?? meta;
      const raw = value.trim();
      if (!raw || busy) return;
      const parsed = parseQuickAdd(raw);
      const errors = [...parsed.errors];
      const unknown: string[] = [];
      // @assignee must exist (PRD §1.3) — but only when the list actually
      // loaded; with no data the server stays the authority.
      if (
        parsed.body.assignee &&
        assignees.length > 0 &&
        !assignees.includes(parsed.body.assignee)
      ) {
        errors.push(`Unknown assignee "@${parsed.body.assignee}"`);
      }
      // *label names resolve case-insensitively against the sidecar set
      // (PRD §3.1): unknown = inline error + create shortcut, never an
      // implicit create.
      const labelIds: string[] = [];
      if (parsed.labels?.length) {
        if (!doc) {
          errors.push("Labels unavailable — task metadata didn't load");
        } else {
          for (const name of parsed.labels) {
            const hit = doc.labels.find(
              (l) => l.name.toLowerCase() === name.toLowerCase(),
            );
            if (hit) labelIds.push(hit.id);
            else unknown.push(name);
          }
          if (unknown.length) {
            errors.push(
              `Unknown label${unknown.length === 1 ? "" : "s"}: ` +
                unknown.map((n) => `*${n}`).join(" "),
            );
          }
        }
      }
      // cycle:<name> resolves the same way (PRD §3.3) but with NO create
      // shortcut: cycles carry a date range, so creating one inline would
      // invent a bogus range — use the Cycles dropdown (smallest reasonable
      // choice; the PRD doesn't specify unknown-cycle behavior).
      let cycleId: string | undefined;
      if (parsed.cycleName !== undefined) {
        if (!doc) {
          errors.push("Cycles unavailable — task metadata didn't load");
        } else {
          const want = parsed.cycleName.toLowerCase();
          const hit = doc.cycles.find((c) => c.name.toLowerCase() === want);
          if (hit) cycleId = hit.id;
          else {
            errors.push(
              `Unknown cycle "${parsed.cycleName}" — create it from the Cycles menu`,
            );
          }
        }
      }
      if (errors.length) {
        setError(errors.join(" · "));
        setUnknownLabels(unknown);
        return;
      }
      setBusy(true);
      setError(null);
      setUnknownLabels([]);
      try {
        const res = await api.createKanbanTask(parsed.body);
        // Sidecar fields (due / labels / estimate / cycle) persist via ONE
        // meta PATCH once the create returns the id (PRD §2.2/§3). Failure
        // keeps the task (already created) and says so instead of
        // pretending the fields stuck.
        const patch: KanbanTaskMetaPatch = {};
        if (parsed.dueAt) patch.due_at = parsed.dueAt;
        if (labelIds.length) patch.labels = labelIds;
        if (parsed.estimate !== undefined) patch.estimate = parsed.estimate;
        if (cycleId) patch.cycle_id = cycleId;
        const wantsMeta = Object.keys(patch).length > 0;
        if (wantsMeta && res.task) {
          try {
            await api.patchKanbanTaskMeta(res.task.id, patch);
            showToast("Task created ✓", "success");
          } catch (e: unknown) {
            showToast(
              `Task created — saving its metadata failed: ${e instanceof Error ? e.message : String(e)}`,
              "error",
            );
          }
        } else if (wantsMeta) {
          // No task in the response (idempotency-key dedupe) — nothing to
          // attach the fields to; surface that rather than dropping them.
          showToast(
            res.warning
              ? `Task created — ${res.warning}; metadata not set`
              : "Task created — metadata not set (no task id returned)",
            "error",
          );
        } else if (res.warning) {
          showToast(`Task created — ${res.warning}`, "success");
        } else {
          showToast("Task created ✓", "success");
        }
        setValue("");
        onCreated();
      } catch (e: unknown) {
        setError(`Create failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [assignees, busy, meta, onCreated, showToast, value],
  );

  // "Create label(s) + retry": append the unknown names to the sidecar set,
  // then resubmit against the doc the PUT returned.
  const createAndRetry = useCallback(async () => {
    if (!unknownLabels.length || busy) return;
    const updated = await onCreateLabels(unknownLabels);
    if (!updated) return;
    setError(null);
    setUnknownLabels([]);
    await submit(updated);
  }, [busy, onCreateLabels, submit, unknownLabels]);

  return (
    <div className="flex flex-col gap-1">
      <Input
        id={QUICK_ADD_INPUT_ID}
        value={value}
        disabled={busy}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) {
            setError(null);
            setUnknownLabels([]);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder='Add task — words !urgent @assignee #tenant *label est:N cycle:name >parent-id due:YYYY-MM-DD · leading ? = triage · "quotes" escape tokens'
        aria-label="Quick add task"
      />
      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-destructive">{error}</p>
          {unknownLabels.length > 0 && (
            <Button
              type="button"
              ghost
              size="sm"
              disabled={busy}
              onClick={() => void createAndRetry()}
            >
              Create label{unknownLabels.length === 1 ? "" : "s"} + retry
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function LinearTasksView({
  teamId,
  configured,
  onTeamChange,
}: {
  teamId: string | null;
  configured: boolean;
  onTeamChange: (teamId: string) => void;
}) {
  const [board, setBoard] = useState<LinearBoard | null>(null);
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    (refresh = false) => {
      setLoading(true);
      api
        .getLinearBoard(teamId, refresh)
        .then(setBoard)
        .catch((e: unknown) =>
          setBoard({
            connected: false,
            reason: e instanceof Error ? e.message : String(e),
            columns: [],
          }),
        )
        .finally(() => setLoading(false));
    },
    [teamId],
  );

  useEffect(() => {
    if (configured) load();
  }, [configured, load]);

  useEffect(() => {
    if (!configured) return;
    api
      .getLinearTeams()
      .then((r) => setTeams(r.teams))
      .catch(() => {});
  }, [configured]);

  if (!configured) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <KeyRound className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Linear isn't connected yet. Add your <code>LINEAR_API_KEY</code>{" "}
            under{" "}
            <Link to="/env" className="underline text-foreground">
              Settings &rarr; Keys
            </Link>{" "}
            to show your Linear issues here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Select
          value={teamId ?? ""}
          onValueChange={onTeamChange}
          aria-label="Linear team"
        >
          <SelectOption value="">All teams</SelectOption>
          {teams.map((t) => (
            <SelectOption key={t.id} value={t.id}>
              {t.name} ({t.key})
            </SelectOption>
          ))}
        </Select>
        <Button
          type="button"
          ghost
          size="icon"
          aria-label="Refresh Linear board"
          onClick={() => load(true)}
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>

      {board == null ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !board.connected ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Couldn't reach Linear{board.reason ? `: ${board.reason}` : ""}.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {board.columns.map((col) => (
            <div key={col.name} className="flex flex-col gap-2">
              <div className="flex items-center gap-2 px-1">
                <span className="text-sm font-medium">{col.name}</span>
                <span className="text-xs text-muted-foreground">
                  {col.issues.length}
                </span>
              </div>
              {col.issues.map((issue) => (
                <Card key={issue.id}>
                  <CardContent className="flex flex-col gap-1.5 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        {issue.identifier}
                      </span>
                      <a
                        href={issue.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${issue.identifier} in Linear`}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                    <p className="text-sm leading-snug">{issue.title}</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {issue.priority in PRIORITY_LABELS && (
                        <Badge tone={issue.priority === 1 ? "warning" : "outline"}>
                          {PRIORITY_LABELS[issue.priority]}
                        </Badge>
                      )}
                      {issue.assignee && (
                        <span className="text-xs text-muted-foreground">
                          {issue.assignee}
                        </span>
                      )}
                      {issue.project && (
                        <span className="text-xs text-muted-foreground">
                          · {issue.project}
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
              {col.issues.length === 0 && (
                <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                  Empty
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
