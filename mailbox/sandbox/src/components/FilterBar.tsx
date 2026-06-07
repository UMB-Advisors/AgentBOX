// STAQPRO-404 deliverable #1 — multi-select filter chips bar covering all five
// filter dimensions called out in the Linear ticket: category, status, route,
// confidence band, age band.
//
// Stateless / presentational. Filter state lives in App.tsx; this component
// just renders the chips and emits onChange. Each filter dimension is a Set
// where empty == "no filter applied for this dimension" (the "all"
// interpretation). The chip toggle adds/removes a value from the set.
//
// Design language matches App.tsx's existing CATEGORY_COLORS / STATUS_COLORS
// palette: zinc base, indigo active, soft pastel rings for category-specific
// chips. Tailwind v4 utility classes only — no theme tokens needed.

import { useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import clsx from "clsx";
import type { DraftStatus } from "../fixtures/drafts";
import {
  ALL_AGE_BANDS,
  ALL_CATEGORIES,
  ALL_CONFIDENCE_BANDS,
  ALL_ROUTES,
  ALL_STATUSES,
  AGE_BAND_LABELS,
  CONFIDENCE_BAND_LABELS,
  type AgeBand,
  type ConfidenceBand,
  type Route,
} from "../lib/urgency";

export interface FilterState {
  /** Empty set = "all categories"; otherwise only listed categories pass. */
  categories: ReadonlySet<string>;
  statuses: ReadonlySet<DraftStatus>;
  routes: ReadonlySet<Route>;
  confidence_bands: ReadonlySet<ConfidenceBand>;
  age_bands: ReadonlySet<AgeBand>;
}

export const EMPTY_FILTERS: FilterState = {
  categories: new Set<string>(),
  statuses: new Set<DraftStatus>(),
  routes: new Set<Route>(),
  confidence_bands: new Set<ConfidenceBand>(),
  age_bands: new Set<AgeBand>(),
};

export function filtersActive(state: FilterState): boolean {
  return (
    state.categories.size > 0 ||
    state.statuses.size > 0 ||
    state.routes.size > 0 ||
    state.confidence_bands.size > 0 ||
    state.age_bands.size > 0
  );
}

/**
 * Counts map shape — keyed by `<dimension>:<value>`. The App computes these
 * from the UNFILTERED set so chip counts don't collapse to zero when the
 * user starts toggling chips. e.g. `"category:reorder"` → 3.
 */
export type FilterCounts = Readonly<Record<string, number>>;

interface FilterBarProps {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  counts: FilterCounts;
  /** Initial expanded state — defaults to false (collapsed). */
  defaultExpanded?: boolean;
}

function activeFilterCount(state: FilterState): number {
  return (
    state.categories.size +
    state.statuses.size +
    state.routes.size +
    state.confidence_bands.size +
    state.age_bands.size
  );
}

// Pastel-with-ring chip palette — matches the App.tsx CATEGORY_COLORS rhythm.
// Active state: solid indigo; inactive: white-on-zinc with subtle ring.
function chipClasses(active: boolean): string {
  return clsx(
    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition-colors",
    active
      ? "bg-indigo-600 text-white ring-indigo-600"
      : "bg-white text-zinc-700 ring-zinc-200 hover:bg-zinc-50",
  );
}

function toggle<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function FilterBar({
  filters,
  onChange,
  counts,
  defaultExpanded = false,
}: FilterBarProps) {
  const active = filtersActive(filters);
  const activeCount = activeFilterCount(filters);
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="flex flex-col border-b border-zinc-200 bg-white">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-50"
        aria-expanded={expanded}
        title={expanded ? "Collapse filters" : "Expand filters"}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />
        )}
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-600">
          Filters
        </span>
        {active ? (
          <span className="inline-flex items-center rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
            {activeCount} active
          </span>
        ) : (
          <span className="text-[11px] text-zinc-400">none active</span>
        )}
        {active && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onChange(EMPTY_FILTERS);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onChange(EMPTY_FILTERS);
              }
            }}
            className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100"
            title="Clear all filters"
          >
            <X className="h-3 w-3" />
            Clear all
          </span>
        )}
      </button>
      {expanded && (
        <div className="flex flex-col gap-2 px-3 pb-2">
          <ChipGroup label="Category">
        {ALL_CATEGORIES.map((cat) => {
          const count = counts[`category:${cat}`] ?? 0;
          const isActive = filters.categories.has(cat);
          return (
            <Chip
              key={cat}
              active={isActive}
              count={count}
              onClick={() =>
                onChange({ ...filters, categories: toggle(filters.categories, cat) })
              }
            >
              {cat}
            </Chip>
          );
        })}
      </ChipGroup>

      <ChipGroup label="Status">
        {ALL_STATUSES.map((s) => {
          const count = counts[`status:${s}`] ?? 0;
          const isActive = filters.statuses.has(s);
          return (
            <Chip
              key={s}
              active={isActive}
              count={count}
              onClick={() =>
                onChange({ ...filters, statuses: toggle(filters.statuses, s) })
              }
            >
              {s}
            </Chip>
          );
        })}
      </ChipGroup>

      <ChipGroup label="Route">
        {ALL_ROUTES.map((r) => {
          const count = counts[`route:${r}`] ?? 0;
          const isActive = filters.routes.has(r);
          return (
            <Chip
              key={r}
              active={isActive}
              count={count}
              onClick={() =>
                onChange({ ...filters, routes: toggle(filters.routes, r) })
              }
            >
              {r}
            </Chip>
          );
        })}
      </ChipGroup>

      <ChipGroup label="Confidence">
        {ALL_CONFIDENCE_BANDS.map((b) => {
          const count = counts[`confidence:${b}`] ?? 0;
          const isActive = filters.confidence_bands.has(b);
          return (
            <Chip
              key={b}
              active={isActive}
              count={count}
              onClick={() =>
                onChange({
                  ...filters,
                  confidence_bands: toggle(filters.confidence_bands, b),
                })
              }
            >
              {CONFIDENCE_BAND_LABELS[b]}
            </Chip>
          );
        })}
      </ChipGroup>

      <ChipGroup label="Age">
        {ALL_AGE_BANDS.map((b) => {
          const count = counts[`age:${b}`] ?? 0;
          const isActive = filters.age_bands.has(b);
          return (
            <Chip
              key={b}
              active={isActive}
              count={count}
              onClick={() =>
                onChange({ ...filters, age_bands: toggle(filters.age_bands, b) })
              }
            >
              {AGE_BAND_LABELS[b]}
            </Chip>
          );
        })}
      </ChipGroup>
        </div>
      )}
    </div>
  );
}

function ChipGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      {children}
    </div>
  );
}

function Chip({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className={chipClasses(active)}>
      <span>{children}</span>
      {count > 0 && (
        <span
          className={clsx(
            "rounded-full px-1.5 text-[9px] font-medium tabular-nums",
            active ? "bg-indigo-700/40 text-white" : "bg-zinc-100 text-zinc-600",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}
