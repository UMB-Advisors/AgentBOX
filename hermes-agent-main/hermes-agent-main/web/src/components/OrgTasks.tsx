import { useCallback, useEffect, useState } from "react";
import { ExternalLink, KeyRound, RefreshCw } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Link } from "react-router-dom";
import { PluginPage } from "@/plugins";
import KanbanListView from "@/components/KanbanListView";
import { cn } from "@/lib/utils";
import {
  api,
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
  const [subView, setSubView] = useState<NativeSubView>(readStoredSubView);

  const selectSubView = useCallback((v: NativeSubView) => {
    setSubView(v);
    try {
      localStorage.setItem(SUBVIEW_STORAGE_KEY, v);
    } catch {
      // Persistence is best-effort; the toggle still works for the session.
    }
  }, []);

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
          <div className="flex flex-col gap-3">
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
            {subView === "board" ? (
              <PluginPage name={kanbanName} />
            ) : (
              <KanbanListView onOpenBoard={() => selectSubView("board")} />
            )}
          </div>
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
