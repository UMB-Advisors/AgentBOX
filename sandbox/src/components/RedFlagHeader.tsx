// STAQPRO-404 deliverable #5 — dashboard-wide red-flag header.
//
// CHOICE: chip, NOT banner.
//   - A full-width banner steals vertical space at the top of the queue and
//     repeats the information that the per-row UrgencyBadge already shows.
//   - A chip sits in the existing header bar next to the toolbar, gets one
//     glance from the operator, and disappears (visually) when the queue is
//     under control. That's the "Inbox Zero for urgency" feel we want.
//   - The chip is clickable: onClick callback wires (in App.tsx) to "filter
//     to pending only" so the operator can drill in with one click.
//
// Two visual states:
//   - urgentCount === 0 → calm "All clear" pill (CheckCircle, emerald).
//   - urgentCount > 0   → red-tinted "N urgent untouched" chip (Flame).
//
// Stateless / presentational; state lives in App.tsx.

import clsx from "clsx";
import { CheckCircle2, Flame } from "lucide-react";

interface RedFlagHeaderProps {
  urgentCount: number;
  total: number;
  onClick?: () => void;
}

export function RedFlagHeader({ urgentCount, total, onClick }: RedFlagHeaderProps) {
  if (urgentCount === 0) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200"
        title={
          total === 0
            ? "Queue empty"
            : `${total} draft${total === 1 ? "" : "s"} visible, none urgent`
        }
      >
        <CheckCircle2 className="h-3.5 w-3.5" />
        All clear
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1 text-[11px] font-semibold text-red-700 ring-1 ring-red-200 transition-colors",
        onClick && "hover:bg-red-100",
      )}
      title={`${urgentCount} pending draft${urgentCount === 1 ? "" : "s"} with at least one urgency signal — click to filter`}
    >
      <Flame className="h-3.5 w-3.5" />
      <span>
        {urgentCount} urgent untouched
      </span>
    </button>
  );
}
