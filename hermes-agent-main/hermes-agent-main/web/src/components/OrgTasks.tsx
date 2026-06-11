import { useCallback, useEffect, useMemo, useState } from "react";
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
import KanbanListView, {
  type GroupBy,
  type TaskContextAction,
} from "@/components/KanbanListView";
import { cn } from "@/lib/utils";
import { parseQuickAdd } from "@/lib/quickAdd";
import {
  api,
  type KanbanTask,
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

  const selectSubView = useCallback((v: NativeSubView) => {
    setSubView(v);
    try {
      localStorage.setItem(SUBVIEW_STORAGE_KEY, v);
    } catch {
      // Persistence is best-effort; the toggle still works for the session.
    }
  }, []);

  const bumpRefresh = useCallback(() => setRefreshNonce((n) => n + 1), []);

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
        showToast={showToast}
        onCreated={bumpRefresh}
      />

      {subView === "board" ? (
        <PluginPage name={kanbanName} />
      ) : (
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
        />
      )}

      <CommandPalette
        open={palette.open}
        onClose={closePalette}
        commands={commands}
        tasks={paletteTasks}
        assignees={assigneeNames}
        initialTask={palette.task}
        initialAction={palette.action}
        onOpenTask={openTaskDetail}
        onMutated={bumpRefresh}
        notify={showToast}
      />
    </div>
  );
}

function QuickAddBar({
  assignees,
  showToast,
  onCreated,
}: {
  assignees: string[];
  showToast: (message: string, type: "error" | "success") => void;
  onCreated: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const raw = value.trim();
    if (!raw || busy) return;
    const parsed = parseQuickAdd(raw);
    const errors = [...parsed.errors];
    // @assignee must exist (PRD §1.3) — but only when the list actually
    // loaded; with no data the server stays the authority.
    if (
      parsed.body.assignee &&
      assignees.length > 0 &&
      !assignees.includes(parsed.body.assignee)
    ) {
      errors.push(`Unknown assignee "@${parsed.body.assignee}"`);
    }
    if (errors.length) {
      setError(errors.join(" · "));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.createKanbanTask(parsed.body);
      if (parsed.dueAt) {
        // Parsed but intentionally NOT persisted: the due-date sidecar
        // store ships in Phase 2 (PRD §1.3 / §2.2).
        showToast("Task created — due dates land in Phase 2", "success");
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
  }, [assignees, busy, onCreated, showToast, value]);

  return (
    <div className="flex flex-col gap-1">
      <Input
        id={QUICK_ADD_INPUT_ID}
        value={value}
        disabled={busy}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder='Add task — words !urgent @assignee #tenant >parent-id due:YYYY-MM-DD · leading ? = triage · "quotes" escape tokens'
        aria-label="Quick add task"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
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
