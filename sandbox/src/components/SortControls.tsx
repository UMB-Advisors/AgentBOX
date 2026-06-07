// STAQPRO-404 deliverable #2 — segmented sort control for the queue list.
//
// Three sort modes:
//   - newest:  received_at desc (default; matches current App behavior)
//   - oldest:  received_at asc
//   - urgency: urgency_score desc, received_at tiebreaker
//
// Active state mirrors the existing nav-active style elsewhere in the
// sandbox (indigo bg, white text). Stateless / presentational.

import clsx from "clsx";
import { ArrowDownNarrowWide, ArrowUpNarrowWide, Flame } from "lucide-react";

export type SortKey = "newest" | "oldest" | "urgency";

interface SortControlsProps {
  sort: SortKey;
  onChange: (next: SortKey) => void;
}

const OPTIONS: ReadonlyArray<{
  key: SortKey;
  label: string;
  icon: typeof Flame;
}> = [
  { key: "newest", label: "Newest", icon: ArrowDownNarrowWide },
  { key: "oldest", label: "Oldest", icon: ArrowUpNarrowWide },
  { key: "urgency", label: "Urgency", icon: Flame },
] as const;

export function SortControls({ sort, onChange }: SortControlsProps) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-full bg-zinc-100 p-0.5"
      role="group"
      aria-label="Sort order"
    >
      {OPTIONS.map(({ key, label, icon: Icon }) => {
        const active = sort === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={clsx(
              "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium transition-colors",
              active
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-zinc-600 hover:bg-white",
            )}
            aria-pressed={active}
          >
            <Icon className="h-3 w-3" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
