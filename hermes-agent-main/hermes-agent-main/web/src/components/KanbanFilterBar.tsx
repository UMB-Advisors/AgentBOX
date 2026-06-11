import { useEffect, useState } from "react";
import { Check, Pencil, Plus, Tag, Trash2, X } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@nous-research/ui/ui/components/dialog";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { cn } from "@/lib/utils";
import type { KanbanFilterState, KanbanLabel, KanbanSavedView } from "@/lib/api";

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

// Fixed 8-swatch label palette (PRD §3.1). The server validates any #rrggbb,
// but the UI only ever offers these.
export const LABEL_PALETTE: readonly string[] = [
  "#6366f1", // indigo
  "#0ea5e9", // sky
  "#22c55e", // green
  "#eab308", // yellow
  "#f97316", // orange
  "#ef4444", // red
  "#ec4899", // pink
  "#6b7280", // gray
];

/** New label with a palette color rotated by position — shared by the manage
 *  dialog and the quick-add unknown-label create shortcut (PRD §3.1). */
export function makeLabel(name: string, existing: KanbanLabel[]): KanbanLabel {
  return {
    id: `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    color: LABEL_PALETTE[existing.length % LABEL_PALETTE.length],
  };
}

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
  labels,
  onSaveLabels,
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
  /** Sidecar label set — drives the filter dropdown + manage dialog (§3.1). */
  labels: KanbanLabel[];
  /** Full-array label replace (parent owns the PUT + meta state). */
  onSaveLabels: (labels: KanbanLabel[]) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [manageLabelsOpen, setManageLabelsOpen] = useState(false);

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

      <LabelFilterDropdown
        labels={labels}
        selected={filter.labels}
        onToggle={(id) =>
          onFilterChange({
            ...filter,
            labels: filter.labels.includes(id)
              ? filter.labels.filter((l) => l !== id)
              : [...filter.labels, id],
          })
        }
        onManage={() => setManageLabelsOpen(true)}
      />

      <Input
        value={filter.text}
        onChange={(e) => onFilterChange({ ...filter, text: e.target.value })}
        placeholder="Filter text..."
        aria-label="Filter tasks by text"
        className="ml-auto w-44"
      />

      <ManageLabelsDialog
        open={manageLabelsOpen}
        onOpenChange={setManageLabelsOpen}
        labels={labels}
        onSave={onSaveLabels}
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

// Multi-select label filter (PRD §3.1): toggling a label ANY-matches it in
// FilterState.labels. Hand-rolled popover (button + panel + transparent
// backdrop) to match the list view's help popover — no new deps.
function LabelFilterDropdown({
  labels,
  selected,
  onToggle,
  onManage,
}: {
  labels: KanbanLabel[];
  selected: string[];
  onToggle: (id: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button
        type="button"
        ghost
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        prefix={<Tag className="h-3.5 w-3.5" />}
      >
        Labels{selected.length > 0 ? ` (${selected.length})` : ""}
      </Button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            aria-label="Filter by label"
            className="absolute left-0 z-50 mt-1 w-56 rounded-md border border-border bg-card p-1 shadow-xl"
          >
            {labels.length === 0 && (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                No labels yet.
              </p>
            )}
            {labels.map((l) => (
              <button
                key={l.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={selected.includes(l.id)}
                onClick={() => onToggle(l.id)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-midground/5"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: l.color }}
                />
                <span className="min-w-0 flex-1 truncate">{l.name}</span>
                {selected.includes(l.id) && (
                  <Check className="h-3.5 w-3.5 shrink-0" />
                )}
              </button>
            ))}
            <div className="mt-1 border-t border-border pt-1">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onManage();
                }}
                className="w-full rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-midground/5 hover:text-foreground"
              >
                Manage labels…
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Label CRUD dialog (PRD §3.1): name + fixed 8-swatch color. One shared form
// drives both create (editingId null) and edit; every action round-trips
// through onSave (full-array PUT — the server scrubs deleted ids off tasks).
function ManageLabelsDialog({
  open,
  onOpenChange,
  labels,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labels: KanbanLabel[];
  onSave: (labels: KanbanLabel[]) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(LABEL_PALETTE[0]);

  // Reset to "create" mode whenever the dialog opens or the set changes
  // (i.e. right after a save lands).
  useEffect(() => {
    setEditingId(null);
    setName("");
    setColor(LABEL_PALETTE[labels.length % LABEL_PALETTE.length]);
  }, [open, labels]);

  // Duplicate names would make quick-add's name→id resolution ambiguous
  // (the server doesn't enforce uniqueness) — block them client-side.
  const trimmed = name.trim();
  const duplicate = labels.some(
    (l) =>
      l.id !== editingId && l.name.toLowerCase() === trimmed.toLowerCase(),
  );

  const submit = () => {
    if (!trimmed || duplicate) return;
    if (editingId != null) {
      onSave(
        labels.map((l) =>
          l.id === editingId ? { ...l, name: trimmed, color } : l,
        ),
      );
    } else {
      onSave([...labels, { ...makeLabel(trimmed, labels), color }]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Manage labels</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-0.5">
          {labels.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No labels yet — add one below.
            </p>
          )}
          {labels.map((l) => (
            <div key={l.id} className="flex items-center gap-2 py-0.5">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: l.color }}
              />
              <span className="min-w-0 flex-1 truncate text-sm">{l.name}</span>
              <Button
                type="button"
                ghost
                size="icon"
                aria-label={`Edit label ${l.name}`}
                onClick={() => {
                  setEditingId(l.id);
                  setName(l.name);
                  setColor(l.color);
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                ghost
                size="icon"
                aria-label={`Delete label ${l.name}`}
                onClick={() => onSave(labels.filter((x) => x.id !== l.id))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>

        <form
          className="grid gap-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Label htmlFor="kanban-label-name">
            {editingId != null ? "Edit label" : "New label"}
          </Label>
          <Input
            id="kanban-label-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Label name"
          />
          <div
            className="flex items-center gap-1.5"
            role="radiogroup"
            aria-label="Label color"
          >
            {LABEL_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
                className={cn(
                  "h-5 w-5 rounded-full border-2",
                  color === c ? "border-foreground" : "border-transparent",
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          {duplicate && (
            <p className="text-xs text-destructive">
              A label with that name already exists.
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!trimmed || duplicate}>
              {editingId != null ? "Save" : "Add"}
            </Button>
            {editingId != null && (
              <Button
                type="button"
                ghost
                size="sm"
                onClick={() => {
                  setEditingId(null);
                  setName("");
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
