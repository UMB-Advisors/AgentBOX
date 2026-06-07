import type { ClassificationCategory, UrgencySignal } from '@/lib/types';

// MBOX-134 — urgency rule evaluator. Pure, dependency-free scoring of a single
// queued draft. The SQL query helper (getQueueWithUrgency in lib/queries.ts)
// computes the same signals set-wise in Postgres so we never ship N+1 calls;
// THIS function is the single-row reference implementation, the SoT the
// evaluator unit tests pin, and the fallback for any caller that already has a
// row in hand. Keep the two in lockstep — the rule set and thresholds live
// here.
//
// Rules (from the issue):
//   - escalate category            → 'escalate'
//   - age > threshold(category) while status is 'pending' → 'aged'
//   - sender on the VIP list        → 'vip'
//   - confidence < LOW_CONF_FLOOR   → 'low_conf'
// urgent === (at least one signal fired).

// Confidence floor — mirrors the cloud-route safety net in
// lib/classification/prompt.ts:routeFor (confidence < 0.75 → cloud). A draft
// that classified below this is low-confidence enough to want eyes on it.
export const LOW_CONF_FLOOR = 0.75;

// Per-category age thresholds in HOURS. Resolved per the issue's open question
// in favour of ENV (no urgency_thresholds table). Each category reads its own
// URGENCY_AGE_HOURS_<CATEGORY> var; unset falls back to the issue's defaults
// (4h inquiry/reorder, 24h follow_up, 1h escalate). Categories without an
// explicit default use DEFAULT_AGE_HOURS.
//
// The compose `mailbox-dashboard` environment block forwards each var with a
// matching ${VAR:-default} so unset === current behavior (MBOX-306 convention).
const DEFAULT_AGE_HOURS = 4;

const AGE_HOURS_DEFAULTS: Partial<Record<ClassificationCategory, number>> = {
  inquiry: 4,
  reorder: 4,
  follow_up: 24,
  escalate: 1,
};

// The env var name for a category's age threshold, e.g.
// 'follow_up' → 'URGENCY_AGE_HOURS_FOLLOW_UP'.
export function ageHoursEnvVar(category: ClassificationCategory): string {
  return `URGENCY_AGE_HOURS_${category.toUpperCase()}`;
}

// Resolve the age threshold (hours) for a category: env override → per-category
// default → DEFAULT_AGE_HOURS. A non-finite / non-positive env value is ignored
// (falls through to the default) so a typo can't silently disable aging.
export function ageThresholdHours(
  category: ClassificationCategory | null | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  const fallback = (category && AGE_HOURS_DEFAULTS[category]) ?? DEFAULT_AGE_HOURS;
  if (!category) return fallback;
  const raw = env[ageHoursEnvVar(category)];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface UrgencyInput {
  category: ClassificationCategory | null | undefined;
  // pg returns NUMERIC/REAL confidence as a string via the type-parser
  // overrides; accept number too for in-memory callers.
  confidence: number | string | null | undefined;
  status: string;
  // Draft age in hours (now - created_at). Pre-computed by the caller so this
  // function stays pure / clock-free.
  ageHours: number;
  // Whether the sender matched the VIP list. The match itself (exact-email vs
  // domain-suffix) is resolved by the caller / the SQL — see lib/queries-vip.ts
  // and getQueueWithUrgency. This flag is just the resolved result.
  isVip: boolean;
}

export interface UrgencyResult {
  urgent: boolean;
  signals: UrgencySignal[];
}

export function evaluateUrgency(
  input: UrgencyInput,
  env: Record<string, string | undefined> = process.env,
): UrgencyResult {
  const signals: UrgencySignal[] = [];

  // Order matters for display priority (see URGENCY_SIGNALS in lib/types.ts):
  // escalate → vip → aged → low_conf.
  if (input.category === 'escalate') {
    signals.push('escalate');
  }

  if (input.isVip) {
    signals.push('vip');
  }

  // Aging only applies while the draft is still awaiting operator action.
  // 'pending' is the only actionable-and-aging status per the issue ('edited'
  // is operator-touched already, 'approved' is past the queue). A draft older
  // than its category threshold while pending is urgent.
  if (input.status === 'pending') {
    const threshold = ageThresholdHours(input.category, env);
    if (input.ageHours > threshold) {
      signals.push('aged');
    }
  }

  const conf =
    input.confidence === null || input.confidence === undefined ? null : Number(input.confidence);
  // Missing confidence is treated as low-confidence (something to look at), not
  // silently safe — mirrors the cloud-route safety net's bias.
  if (conf === null || (Number.isFinite(conf) && conf < LOW_CONF_FLOOR)) {
    signals.push('low_conf');
  }

  return { urgent: signals.length > 0, signals };
}
