// STAQPRO-331 #8 — threshold semantics for the FreshnessChip. Lives in
// /lib (not /components) so vitest's vite resolver picks it up without
// running through the JSX import-analysis path. Pure; no React.

export const FRESH_MS = 15 * 60 * 1000;
export const STALE_MS = 2 * 60 * 60 * 1000;
export const OVERDUE_MS = 8 * 60 * 60 * 1000;

export type Freshness = 'fresh' | 'neutral' | 'stale' | 'overdue';

// Mapping is left-inclusive on each threshold so the operator-facing
// mental model ("over 15 min = no longer fresh") matches the math.
export function freshnessFor(diffMs: number): Freshness {
  if (diffMs < FRESH_MS) return 'fresh';
  if (diffMs < STALE_MS) return 'neutral';
  if (diffMs < OVERDUE_MS) return 'stale';
  return 'overdue';
}

export function formatDuration(diffMs: number): string {
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}
