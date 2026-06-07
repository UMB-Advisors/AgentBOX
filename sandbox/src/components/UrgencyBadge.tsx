// STAQPRO-404 deliverable #4 — per-row urgency badge.
//
// Rendering rules:
//   - 0 signals  → returns null (no chrome added to non-urgent rows).
//   - 1 signal   → a small colored pill with the signal's label + icon.
//   - >=2 signals → a single AGGREGATE icon (AlertOctagon) with the count
//                   and a title=... tooltip listing the signal names. Per
//                   the plan we deliberately do NOT render N tiny pills —
//                   the aggregate is the whole point of the deliverable.
//
// Stateless / presentational. The signal palette mirrors the project's
// existing semantic colors (red for escalate, amber for aged/vip-ish,
// zinc for low-conf) so the row's visual rhythm stays consistent with
// the rest of the dashboard.

import clsx from "clsx";
import {
  AlertOctagon,
  AlertTriangle,
  Clock,
  HelpCircle,
  Star,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  SIGNAL_LABELS,
  type UrgencySignal,
} from "../lib/urgency";

interface UrgencyBadgeProps {
  signals: readonly UrgencySignal[];
}

interface SignalVisual {
  icon: LucideIcon;
  classes: string;
}

const SIGNAL_VISUALS: { readonly [K in UrgencySignal]: SignalVisual } = {
  escalate: {
    icon: AlertTriangle,
    classes: "bg-red-100 text-red-700 ring-red-200",
  },
  aged: {
    icon: Clock,
    classes: "bg-amber-100 text-amber-800 ring-amber-200",
  },
  vip: {
    icon: Star,
    classes: "bg-yellow-100 text-yellow-800 ring-yellow-300",
  },
  low_conf: {
    icon: HelpCircle,
    classes: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  },
} as const;

export function UrgencyBadge({ signals }: UrgencyBadgeProps) {
  if (signals.length === 0) return null;

  if (signals.length === 1) {
    const sig = signals[0];
    const { icon: Icon, classes } = SIGNAL_VISUALS[sig];
    return (
      <span
        className={clsx(
          "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1",
          classes,
        )}
        title={SIGNAL_LABELS[sig]}
      >
        <Icon className="h-3 w-3" />
        {SIGNAL_LABELS[sig]}
      </span>
    );
  }

  // Aggregate: 2+ signals fire on the same row.
  const tooltip = signals.map((s) => SIGNAL_LABELS[s]).join(" · ");
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white ring-1 ring-red-700"
      title={`${signals.length} urgency signals: ${tooltip}`}
    >
      <AlertOctagon className="h-3 w-3" />
      {signals.length}
    </span>
  );
}
