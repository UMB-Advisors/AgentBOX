// STAQPRO-404 Phase 1 — sandbox-only urgency engine.
//
// All functions here are pure and deterministic: given the same DraftRow and
// the same `now`, they always return the same values. The `now` argument
// defaults to `new Date()` but is exposed on every function so tests + the
// daily-digest preview can pin the clock.
//
// Production seam (Phase 2 dashboard port): these helpers live in the
// sandbox to lock in the contract. The dashboard will implement the same
// `deriveSignals` / `urgencyScore` / `route` / band helpers, sourced from
// real DB row shapes (kysely codegen) instead of the synthetic DraftRow.
// Tests will guard the helper outputs once they port over.

import type { DraftRow, DraftStatus } from "../fixtures/drafts";

// ----- Public types -----

export type UrgencySignal = "escalate" | "aged" | "vip" | "low_conf";
export type Route = "local" | "cloud";
export type ConfidenceBand = "high" | "med" | "low";
export type AgeBand = "lt_1h" | "1_to_4h" | "4_to_24h" | "gt_24h";

export interface RowDerived {
  signals: readonly UrgencySignal[];
  urgency_score: number;
  route: Route;
  confidence_band: ConfidenceBand | null;
  age_band: AgeBand | null;
}

// ----- Constants (exported for use by FilterBar / SortControls / etc.) -----

/**
 * Weights chosen so escalate + vip dominate the sort order; aged on its own
 * sits below either of those; low_conf alone is a hint but not a klaxon.
 * Tweakable; once we land a "weights tuning" surface in production this will
 * move to mailbox.persona or an env var.
 */
export const SIGNAL_WEIGHTS: { readonly [K in UrgencySignal]: number } = {
  escalate: 3,
  vip: 3,
  aged: 2,
  low_conf: 1,
} as const;

export const AGED_THRESHOLD_HOURS = 4;
export const LOW_CONF_THRESHOLD = 0.75;

/**
 * Categories that route to the cloud model in production
 * (dashboard/lib/classification/routing — `CLOUD_CATEGORIES`). Mirrored here
 * so the sandbox `route` filter chip stays consistent with prod semantics.
 */
export const CLOUD_CATEGORIES = ["escalate", "unknown"] as const;
export type CloudCategory = (typeof CLOUD_CATEGORIES)[number];

/**
 * Categories the operator can override to via inline ClassificationOverride.
 * Mirrors `dashboard/lib/classification/prompt.ts` MAIL-05 taxonomy.
 */
export const ALL_CATEGORIES = [
  "escalate",
  "reorder",
  "scheduling",
  "follow_up",
  "internal",
  "inquiry",
  "unknown",
  "spam_marketing",
] as const;
export type Category = (typeof ALL_CATEGORIES)[number];

export const ALL_STATUSES: readonly DraftStatus[] = [
  "pending",
  "approved",
  "sent",
  "rejected",
] as const;

export const ALL_ROUTES: readonly Route[] = ["local", "cloud"] as const;

export const ALL_CONFIDENCE_BANDS: readonly ConfidenceBand[] = [
  "high",
  "med",
  "low",
] as const;

export const ALL_AGE_BANDS: readonly AgeBand[] = [
  "lt_1h",
  "1_to_4h",
  "4_to_24h",
  "gt_24h",
] as const;

// ----- Helpers -----

function hoursBetween(thenIso: string, now: Date): number {
  const then = new Date(thenIso).getTime();
  const diffMs = now.getTime() - then;
  return diffMs / (1000 * 60 * 60);
}

function isCloudCategory(category: string): category is CloudCategory {
  return (CLOUD_CATEGORIES as readonly string[]).includes(category);
}

// ----- Derivations -----

export function deriveSignals(
  row: DraftRow,
  now: Date = new Date(),
): readonly UrgencySignal[] {
  const out: UrgencySignal[] = [];
  if (row.classification_category === "escalate") out.push("escalate");
  if (
    row.status === "pending" &&
    row.received_at !== null &&
    hoursBetween(row.received_at, now) > AGED_THRESHOLD_HOURS
  ) {
    out.push("aged");
  }
  if (row.is_vip === true) out.push("vip");
  if (
    row.classification_confidence !== null &&
    row.classification_confidence < LOW_CONF_THRESHOLD
  ) {
    out.push("low_conf");
  }
  return out;
}

export function urgencyScore(row: DraftRow, now: Date = new Date()): number {
  let score = 0;
  for (const sig of deriveSignals(row, now)) {
    score += SIGNAL_WEIGHTS[sig];
  }
  return score;
}

/**
 * Mirror of `dashboard/lib/classification/prompt.ts:routeFor`. Confidence below
 * the threshold OR a cloud-category classification routes the draft to the
 * cloud model; everything else stays on the local Qwen3-4B path.
 */
export function routeFor(row: DraftRow): Route {
  if (
    row.classification_confidence !== null &&
    row.classification_confidence < LOW_CONF_THRESHOLD
  ) {
    return "cloud";
  }
  if (isCloudCategory(row.classification_category)) return "cloud";
  return "local";
}

export function confidenceBand(conf: number | null): ConfidenceBand | null {
  if (conf === null) return null;
  if (conf >= 0.9) return "high";
  if (conf >= LOW_CONF_THRESHOLD) return "med";
  return "low";
}

export function ageBand(
  receivedAt: string | null,
  now: Date = new Date(),
): AgeBand | null {
  if (receivedAt === null) return null;
  const hrs = hoursBetween(receivedAt, now);
  if (hrs < 1) return "lt_1h";
  if (hrs < 4) return "1_to_4h";
  if (hrs < 24) return "4_to_24h";
  return "gt_24h";
}

export function rowDerived(row: DraftRow, now: Date = new Date()): RowDerived {
  return {
    signals: deriveSignals(row, now),
    urgency_score: urgencyScore(row, now),
    route: routeFor(row),
    confidence_band: confidenceBand(row.classification_confidence),
    age_band: ageBand(row.received_at, now),
  };
}

/**
 * "Urgent untouched" = pending AND has at least one urgency signal firing.
 * Drives the dashboard-wide red-flag header chip.
 */
export function isUrgentUntouched(
  row: DraftRow,
  now: Date = new Date(),
): boolean {
  if (row.status !== "pending") return false;
  return urgencyScore(row, now) > 0;
}

// ----- Display labels -----

export const SIGNAL_LABELS: { readonly [K in UrgencySignal]: string } = {
  escalate: "Escalate",
  aged: "Aged",
  vip: "VIP",
  low_conf: "Low conf",
} as const;

export const CONFIDENCE_BAND_LABELS: {
  readonly [K in ConfidenceBand]: string;
} = {
  high: "High (≥0.9)",
  med: "Med (0.75–0.9)",
  low: "Low (<0.75)",
} as const;

export const AGE_BAND_LABELS: { readonly [K in AgeBand]: string } = {
  lt_1h: "< 1h",
  "1_to_4h": "1–4h",
  "4_to_24h": "4–24h",
  gt_24h: "> 24h",
} as const;
