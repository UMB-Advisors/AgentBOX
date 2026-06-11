import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Input } from "@nous-research/ui/ui/components/input";
import { cn } from "@/lib/utils";
import {
  PRIORITY_OPTIONS,
  SETTABLE_STATUSES,
  priorityLabel,
  shortId,
  type TaskContextAction,
} from "@/components/KanbanListView";
import {
  api,
  type KanbanMeta,
  type KanbanTask,
  type KanbanTaskMetaPatch,
  type KanbanUpdateTaskBody,
} from "@/lib/api";

// Command palette for Org Chart > Tasks (PRD docs/kanban-linear-ux.v0.1.0.md
// §1.4). Mounted inside the native Tasks view only — NOT global nav — so the
// Cmd/Ctrl+K listener (owned by OrgTasks) and this overlay both unmount with
// the tab. Two sources at the root: parent-supplied actions and the loaded
// board's tasks; picking a task enters a task-context mode with
// status / priority / assign / archive (confirmed) / comment actions.

/** A top-level palette action supplied by the parent (view switching etc.). */
export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

type Mode =
  | { kind: "root" }
  | { kind: "task"; task: KanbanTask }
  | { kind: "pick"; task: KanbanTask; field: "status" | "priority" | "assignee" }
  | { kind: "label"; task: KanbanTask }
  | { kind: "cycle"; task: KanbanTask }
  | { kind: "archive"; task: KanbanTask }
  | { kind: "comment"; task: KanbanTask };

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

// Simple case-insensitive subsequence match — PRD §1.4 explicitly wants
// "simple subsequence match, no new deps". Ranking is source order, which
// is fine at appliance scale (≤ a few hundred tasks).
function fuzzyMatch(needle: string, haystack: string): boolean {
  const n = needle.toLowerCase();
  if (!n) return true;
  const h = haystack.toLowerCase();
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i += 1;
    if (i === n.length) return true;
  }
  return false;
}

export default function CommandPalette({
  open,
  onClose,
  commands,
  tasks,
  assignees,
  initialTask,
  initialAction,
  meta,
  onOpenTask,
  onMutated,
  notify,
}: {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
  /** Fuzzy-search source (the loaded board, fetched by the parent). */
  tasks: KanbanTask[];
  assignees: string[];
  /** Open directly in a task's context (row hotkeys s/p/a/c, focused row). */
  initialTask: KanbanTask | null;
  initialAction: TaskContextAction | null;
  /** Sidecar meta for the label submenu (PRD §3.1); null while loading. */
  meta: KanbanMeta | null;
  onOpenTask: (task: KanbanTask) => void;
  /** A mutation succeeded — parent refetches its views. */
  onMutated: () => void;
  notify: (message: string, type: "error" | "success") => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "root" });
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const busyRef = useRef(false);

  // (Re)derive the entry mode whenever the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    if (!initialTask) {
      setMode({ kind: "root" });
    } else if (initialAction === "comment") {
      setMode({ kind: "comment", task: initialTask });
    } else if (initialAction) {
      setMode({ kind: "pick", task: initialTask, field: initialAction });
    } else {
      setMode({ kind: "task", task: initialTask });
    }
  }, [open, initialTask, initialAction]);

  useEffect(() => {
    setHighlight(0);
  }, [query, mode]);

  const enter = useCallback((m: Mode) => {
    setMode(m);
    setQuery("");
  }, []);

  const finishMutation = useCallback(
    (message: string) => {
      notify(message, "success");
      onMutated();
      onClose();
    },
    [notify, onMutated, onClose],
  );

  const patchTask = useCallback(
    async (task: KanbanTask, body: KanbanUpdateTaskBody, done: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        await api.updateKanbanTask(task.id, body);
        finishMutation(done);
      } catch (e: unknown) {
        notify(
          `Update failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      } finally {
        busyRef.current = false;
      }
    },
    [finishMutation, notify],
  );

  const patchMeta = useCallback(
    async (task: KanbanTask, body: KanbanTaskMetaPatch, done: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        await api.patchKanbanTaskMeta(task.id, body);
        finishMutation(done);
      } catch (e: unknown) {
        notify(
          `Update failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      } finally {
        busyRef.current = false;
      }
    },
    [finishMutation, notify],
  );

  const submitComment = useCallback(
    async (task: KanbanTask) => {
      const text = query.trim();
      if (!text || busyRef.current) return;
      busyRef.current = true;
      try {
        await api.addKanbanComment(task.id, text);
        finishMutation("Comment added ✓");
      } catch (e: unknown) {
        notify(
          `Comment failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      } finally {
        busyRef.current = false;
      }
    },
    [query, finishMutation, notify],
  );

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    switch (mode.kind) {
      case "root": {
        const actionItems = commands
          .filter((c) => fuzzyMatch(q, c.label))
          .map<PaletteItem>((c) => ({
            id: `cmd:${c.id}`,
            label: c.label,
            hint: c.hint ?? "action",
            run: () => {
              c.run();
              onClose();
            },
          }));
        const taskItems = tasks
          .filter((t) => fuzzyMatch(q, `${shortId(t.id)} ${t.title}`))
          .slice(0, 50)
          .map<PaletteItem>((t) => ({
            id: `task:${t.id}`,
            label: t.title,
            hint: shortId(t.id),
            run: () => enter({ kind: "task", task: t }),
          }));
        return [...actionItems, ...taskItems];
      }
      case "task": {
        const t = mode.task;
        const all: PaletteItem[] = [
          {
            id: "open",
            label: "Open detail",
            run: () => {
              onOpenTask(t);
              onClose();
            },
          },
          {
            id: "status",
            label: "Set status…",
            run: () => enter({ kind: "pick", task: t, field: "status" }),
          },
          {
            id: "priority",
            label: "Set priority…",
            run: () => enter({ kind: "pick", task: t, field: "priority" }),
          },
          {
            id: "assignee",
            label: "Assign to…",
            run: () => enter({ kind: "pick", task: t, field: "assignee" }),
          },
          {
            id: "label",
            label: "Add label…",
            hint: "toggle",
            run: () => enter({ kind: "label", task: t }),
          },
          {
            id: "cycle",
            label: "Set cycle…",
            run: () => enter({ kind: "cycle", task: t }),
          },
          {
            id: "comment",
            label: "Comment…",
            run: () => enter({ kind: "comment", task: t }),
          },
          {
            id: "archive",
            label: "Archive…",
            hint: "confirm",
            run: () => enter({ kind: "archive", task: t }),
          },
        ];
        return all.filter((i) => fuzzyMatch(q, i.label));
      }
      case "pick": {
        // mode.task is a snapshot from palette-open time; resolve the live
        // row from the tasks prop (refreshed by the parent's board fetches)
        // so the "current" hints don't go stale if a background poll lands
        // while the palette is open. Writes only use the id, so the
        // fallback snapshot is always safe.
        const t = tasks.find((x) => x.id === mode.task.id) ?? mode.task;
        if (mode.field === "status") {
          return SETTABLE_STATUSES.filter((st) => fuzzyMatch(q, st)).map<PaletteItem>(
            (st) => ({
              id: st,
              label: st,
              hint: st === t.status ? "current" : undefined,
              run: () => void patchTask(t, { status: st }, `Status → ${st} ✓`),
            }),
          );
        }
        if (mode.field === "priority") {
          return PRIORITY_OPTIONS.filter((o) => fuzzyMatch(q, o.label)).map<PaletteItem>(
            (o) => ({
              id: String(o.value),
              label: o.label,
              hint: o.value === t.priority ? "current" : undefined,
              run: () =>
                void patchTask(t, { priority: o.value }, `Priority → ${o.label} ✓`),
            }),
          );
        }
        // "" unassigns (the PATCH endpoint maps "" to NULL).
        return ["", ...assignees]
          .filter((a) => fuzzyMatch(q, a || "unassigned"))
          .map<PaletteItem>((a) => ({
            id: a || "__unassigned__",
            label: a || "Unassigned",
            hint: (t.assignee ?? "") === a ? "current" : undefined,
            run: () =>
              void patchTask(
                t,
                { assignee: a },
                a ? `Assigned to ${a} ✓` : "Unassigned ✓",
              ),
          }));
      }
      case "label": {
        // Toggle one sidecar label per pick (PRD §3.1 "Add label"); the
        // palette closes on mutation like every other action — reopen to
        // stack more labels (detail panel is the bulk-toggle surface).
        const t = mode.task;
        const all = meta?.labels ?? [];
        if (!all.length) {
          return [
            {
              id: "none",
              label: "No labels defined",
              hint: "manage from the filter bar",
              run: onClose,
            },
          ];
        }
        const assigned = meta?.tasks[t.id]?.labels ?? [];
        return all
          .filter((l) => fuzzyMatch(q, l.name))
          .map<PaletteItem>((l) => {
            const has = assigned.includes(l.id);
            return {
              id: l.id,
              label: l.name,
              hint: has ? "added · pick to remove" : undefined,
              run: () =>
                void patchMeta(
                  t,
                  {
                    labels: has
                      ? assigned.filter((id) => id !== l.id)
                      : [...assigned, l.id],
                  },
                  has ? `Label removed: ${l.name} ✓` : `Label added: ${l.name} ✓`,
                ),
            };
          });
      }
      case "cycle": {
        // Assign / clear the task's sidecar cycle (PRD §3.3).
        const t = mode.task;
        const all = meta?.cycles ?? [];
        if (!all.length) {
          return [
            {
              id: "none",
              label: "No cycles defined",
              hint: "manage from the filter bar",
              run: onClose,
            },
          ];
        }
        const current = meta?.tasks[t.id]?.cycle_id;
        const clear: PaletteItem[] = fuzzyMatch(q, "no cycle")
          ? [
              {
                id: "__none__",
                label: "No cycle",
                hint: current == null ? "current" : undefined,
                run: () => void patchMeta(t, { cycle_id: null }, "Cycle cleared ✓"),
              },
            ]
          : [];
        return [
          ...clear,
          ...all
            .filter((c) => fuzzyMatch(q, c.name))
            .map<PaletteItem>((c) => ({
              id: c.id,
              label: c.name,
              hint: c.id === current ? "current" : undefined,
              run: () =>
                void patchMeta(t, { cycle_id: c.id }, `Cycle → ${c.name} ✓`),
            })),
        ];
      }
      case "archive": {
        const t = mode.task;
        const all: PaletteItem[] = [
          {
            id: "confirm",
            label: "Archive task",
            hint: "confirm",
            run: () => void patchTask(t, { status: "archived" }, "Archived ✓"),
          },
          {
            id: "cancel",
            label: "Cancel",
            run: () => enter({ kind: "task", task: t }),
          },
        ];
        return all.filter((i) => fuzzyMatch(q, i.label));
      }
      case "comment":
        // Free-text mode: the input is the comment body; Enter posts.
        return [];
    }
  }, [mode, query, commands, tasks, assignees, meta, enter, onClose, onOpenTask, patchTask, patchMeta]);

  // Esc backs out one level (submenu → task → root → closed), Linear-style.
  const goBack = useCallback(() => {
    if (mode.kind === "root") {
      onClose();
    } else if (mode.kind === "task") {
      enter({ kind: "root" });
    } else {
      enter({ kind: "task", task: mode.task });
    }
  }, [mode, onClose, enter]);

  // Attached to the panel wrapper (not window) so it lives and dies with the
  // overlay; stopPropagation keeps Esc from also closing the detail panel
  // underneath (its listener sits on document, above React's root).
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      goBack();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(items.length - 1, 0)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (mode.kind === "comment") {
        void submitComment(mode.task);
        return;
      }
      const item = items[highlight];
      if (item) item.run();
    }
  };

  if (!open) return null;

  const placeholder =
    mode.kind === "comment"
      ? "Type a comment, Enter to post…"
      : mode.kind === "root"
        ? "Type a command or search tasks…"
        : "Filter…";

  return (
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center bg-background/60 p-4 pt-[12vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={onKeyDown}
    >
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-md border border-border bg-card shadow-2xl">
        {mode.kind !== "root" && (
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <Badge tone="outline">{shortId(mode.task.id)}</Badge>
            <span className="min-w-0 truncate">{mode.task.title}</span>
            {mode.kind === "pick" && (
              <span className="shrink-0">· set {mode.field}</span>
            )}
            {mode.kind === "label" && <span className="shrink-0">· add label</span>}
            {mode.kind === "cycle" && <span className="shrink-0">· set cycle</span>}
            {mode.kind === "comment" && <span className="shrink-0">· comment</span>}
            {mode.kind === "archive" && <span className="shrink-0">· archive?</span>}
            {mode.kind === "task" && (
              <Badge tone="outline" className="shrink-0">
                {priorityLabel(mode.task.priority)}
              </Badge>
            )}
          </div>
        )}
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
          />
        </div>
        {mode.kind !== "comment" && (
          <ul className="max-h-80 overflow-y-auto py-1" role="listbox">
            {items.map((it, i) => (
              <li key={it.id} role="option" aria-selected={i === highlight}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm",
                    i === highlight ? "bg-midground/10" : "hover:bg-midground/5",
                  )}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => it.run()}
                >
                  <span className="min-w-0 truncate">{it.label}</span>
                  {it.hint && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {it.hint}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {items.length === 0 && (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                No matches
              </li>
            )}
          </ul>
        )}
        <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          ↑↓ navigate · Enter select · Esc back
        </div>
      </div>
    </div>
  );
}
