import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { cn } from "@/lib/utils";
import type { KanbanFilterState, KanbanSavedView } from "@/lib/api";

// Filter chip bar for the native Tasks list (PRD
// docs/kanban-linear-ux.v0.1.0.md §2.1): built-in chips (All / Active /
// Triage / Blocked / Done, plus Overdue once any task carries a due date)
// followed by user-saved views persisted in the kanban-meta sidecar store.
// Selecting a chip replaces the whole FilterState; ad-hoc edits afterwards
// show a dirty dot on the active chip with "Update view" (saved views only)
// and "Save as new" actions. All filtering applies client-side to the loaded
// board -- an appliance board tops out at a few hundred tasks, so no server
// filtering is needed (PRD-noted ceiling; revisit if boards outgrow that).

export const EMPTY_FILTER: KanbanFilterState = {
  statuses: [],
  assignees: [],
  tenants: [],
  labels: [],
  cycleId: null,
  text: "",
  overdueOnly: false,
};

// "Active" = everything between triage and done (PRD §2.1).
const ACTIVE_STATUSES = [
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
];

interface BuiltinView {
  id: string;
  label: string;
  filters: KanbanFilterState;
}

const BUILTIN_VIEWS: BuiltinView[] = [
  { id: "all", label: "All", filters: EMPTY_FILTER },
  {
    id: "active",
    label: "Active",
    filters: { ...EMPTY_FILTER, statuses: ACTIVE_STATUSES },
  },
  { id: "triage", label: "Triage", filters: { ...EMPTY_FILTER, statuses: ["triage"] } },
  { id: "blocked", label: "Blocked", filters: { ...EMPTY_FILTER, statuses: ["blocked"] } },
  { id: "done", label: "Done", filters: { ...EMPTY_FILTER, statuses: ["done"] } },
];

// Rendered only when some task carries a due date (PRD §2.2).
const OVERDUE_VIEW: BuiltinView = {
  id: "overdue",
  label: "Overdue",
  filters: { ...EMPTY_FILTER, overdueOnly: true },
};

/** Order-insensitive FilterState equality -- list order is a UI artifact,
 *  not a semantic difference. Drives chip highlighting + the dirty dot. */
export function sameFilter(a: KanbanFilterState, b: KanbanFilterState): boolean {
  const key = (l: string[]) => [...l].sort().join(" ");
  return (
    key(a.statuses) === key(b.statuses) &&
    key(a.assignees) === key(b.assignees) &&
    key(a.tenants) === key(b.tenants) &&
    key(a.labels) === key(b.labels) &&
    a.cycleId === b.cycleId &&
    a.text.trim() === b.text.trim() &&
    a.overdueOnly === b.overdueOnly
  );
}

export default function KanbanFilterBar({
  filter,
  onFilterChange,
  views,
  activeViewId,
  onSelectView,
  onSaveView,
  onUpdateView,
  onDeleteView,
  showOverdue,
}: {
  filter: KanbanFilterState;
  onFilterChange: (filter: KanbanFilterState) => void;
  /** User-saved views from the meta store (built-ins live here, in code). */
  views: KanbanSavedView[];
  /** Built-in chip id ("all"/"active"/...) or saved-view id; null = ad hoc. */
  activeViewId: string | null;
  onSelectView: (id: string, filters: KanbanFilterState) => void;
  /** Save the CURRENT filter as a new view (parent owns the PUT). */
  onSaveView: (name: string) => void;
  /** Overwrite a saved view's filters with the current filter. */
  onUpdateView: (id: string) => void;
  onDeleteView: (id: string) => void;
  /** Overdue chip renders only when some task has a due date (PRD §2.2). */
  showOverdue: boolean;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const builtins = showOverdue ? [...BUILTIN_VIEWS, OVERDUE_VIEW] : BUILTIN_VIEWS;
  const activeFilters =
    (activeViewId != null
      ? (builtins.find((b) => b.id === activeViewId)?.filters ??
        views.find((v) => v.id === activeViewId)?.filters)
      : undefined) ?? null;
  const dirty = activeFilters != null && !sameFilter(filter, activeFilters);
  const activeIsSaved =
    activeViewId != null && views.some((v) => v.id === activeViewId);

  const submitName = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSaveView(trimmed);
    setName("");
    setNaming(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label="Task filters"
      >
        {builtins.map((b) => (
          <Chip
            key={b.id}
            label={b.label}
            active={activeViewId === b.id}
            dirty={activeViewId === b.id && dirty}
            onSelect={() => onSelectView(b.id, b.filters)}
          />
        ))}
        {views.length > 0 && (
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
        )}
        {views.map((v) => (
          <Chip
            key={v.id}
            label={v.name}
            active={activeViewId === v.id}
            dirty={activeViewId === v.id && dirty}
            onSelect={() => onSelectView(v.id, v.filters)}
            onDelete={() => onDeleteView(v.id)}
          />
        ))}
      </div>

      {naming ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            submitName();
          }}
        >
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setNaming(false);
            }}
            placeholder="View name"
            aria-label="New view name"
            className="w-36"
          />
          <Button type="submit" size="sm" disabled={!name.trim()}>
            Save
          </Button>
          <Button type="button" ghost size="sm" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-1">
          {dirty && activeIsSaved && activeViewId != null && (
            <Button
              type="button"
              ghost
              size="sm"
              onClick={() => onUpdateView(activeViewId)}
            >
              Update view
            </Button>
          )}
          <Button
            type="button"
            ghost
            size="sm"
            onClick={() => setNaming(true)}
            prefix={<Plus className="h-3.5 w-3.5" />}
          >
            {dirty ? "Save as new" : "Save view"}
          </Button>
        </div>
      )}

      <Input
        value={filter.text}
        onChange={(e) => onFilterChange({ ...filter, text: e.target.value })}
        placeholder="Filter text..."
        aria-label="Filter tasks by text"
        className="ml-auto w-44"
      />
    </div>
  );
}

function Chip({
  label,
  active,
  dirty,
  onSelect,
  onDelete,
}: {
  label: string;
  active: boolean;
  /** Ad-hoc edits on top of this view -- dot per PRD §2.1. */
  dirty: boolean;
  onSelect: () => void;
  /** Saved views only; built-ins aren't deletable. */
  onDelete?: () => void;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center overflow-hidden rounded-full border",
        active ? "border-brand" : "border-border",
      )}
    >
      <button
        type="button"
        aria-pressed={active}
        onClick={onSelect}
        className={cn(
          "flex items-center gap-1 px-2.5 py-0.5 text-xs font-medium transition-colors",
          active
            ? "bg-brand text-brand-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {label}
        {dirty && (
          /* bg-current inherits the chip text color, so the dot stays
             visible on both the brand-active and idle chip styles. */
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-current"
            aria-label="Filters modified"
          />
        )}
      </button>
      {onDelete && (
        <button
          type="button"
          aria-label={"Delete view " + label}
          onClick={onDelete}
          className={cn(
            "px-1.5 py-1 transition-colors",
            active
              ? "bg-brand text-brand-foreground"
              : "text-muted-foreground hover:text-destructive",
          )}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
