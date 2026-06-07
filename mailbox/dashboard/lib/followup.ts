import type { ClassificationCategory } from '@/lib/types';

// MBOX-377 — follow-up / no-reply thresholds. Mirrors the MBOX-134 urgency
// age-threshold pattern (lib/urgency.ts:ageThresholdHours): each category reads
// its own FOLLOWUP_AGE_HOURS_<CATEGORY> env var; unset falls back to a
// per-category default → DEFAULT_FOLLOWUP_AGE_HOURS. A non-finite / non-positive
// value is ignored (falls through to the default) so a typo can't silently
// disable follow-up tracking. The compose mailbox-dashboard environment forwards
// each var with ${VAR:-default} (MBOX-306 convention).
//
// Distinct from urgency thresholds: urgency = "a pending DRAFT is aging in the
// queue waiting for the operator"; follow-up = "we already SENT a reply and the
// counterparty has gone quiet". Follow-up windows are deliberately longer —
// chase a dropped thread after days, not the hours urgency uses.

const DEFAULT_FOLLOWUP_AGE_HOURS = 48;

const FOLLOWUP_AGE_HOURS_DEFAULTS: Partial<Record<ClassificationCategory, number>> = {
  inquiry: 48,
  reorder: 48,
  scheduling: 24, // time-sensitive — a quiet scheduling thread is worth chasing sooner
  follow_up: 72,
  internal: 72,
  escalate: 24,
  unknown: 48,
};

// Categories we track for follow-up. spam_marketing is excluded — those threads
// are dropped pre-draft and never warrant a nudge. Drives the SQL threshold CASE
// in lib/queries-followup.ts (ELSE → DEFAULT_FOLLOWUP_AGE_HOURS).
export const FOLLOWUP_CATEGORIES: ClassificationCategory[] = [
  'inquiry',
  'reorder',
  'scheduling',
  'follow_up',
  'internal',
  'escalate',
  'unknown',
];

// The env var name for a category's follow-up threshold, e.g.
// 'follow_up' → 'FOLLOWUP_AGE_HOURS_FOLLOW_UP'.
export function followupAgeHoursEnvVar(category: ClassificationCategory): string {
  return `FOLLOWUP_AGE_HOURS_${category.toUpperCase()}`;
}

// Resolve the follow-up threshold (hours) for a category: env override →
// per-category default → DEFAULT_FOLLOWUP_AGE_HOURS. A non-finite / non-positive
// env value is ignored (falls through to the default).
export function followupThresholdHours(
  category: ClassificationCategory | null | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  const fallback =
    (category && FOLLOWUP_AGE_HOURS_DEFAULTS[category]) ?? DEFAULT_FOLLOWUP_AGE_HOURS;
  if (!category) return fallback;
  const raw = env[followupAgeHoursEnvVar(category)];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
