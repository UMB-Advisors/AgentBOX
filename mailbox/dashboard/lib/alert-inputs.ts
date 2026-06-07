// MBOX-185 (FR-22) — shared alert-input assembly.
//
// ONE place that gathers the inputs for evaluateAlerts (lib/alerts.ts) from the
// live status sources, so the operator-facing /api/system/status page and the
// new email push path (/api/internal/alert-check) evaluate the EXACT same
// thresholds against the EXACT same data. No second stats engine — this reuses
// the STAQPRO-128/146 query helpers + the MBOX-166/168 preflight checks.
//
// Each source already fails closed (returns null / a red status on error); we
// mirror that here so a single unreachable upstream degrades to "that input is
// skipped" rather than failing the whole evaluation.

import {
  type Alert,
  type AlertInputs,
  COST_SPIKE_MIN_TRIGGER_USD,
  DRAFT_BACKLOG_THRESHOLD_HOURS,
  evaluateAlerts,
} from '@/lib/alerts';
import { checkMemoryPressure } from '@/lib/preflight/memory';
import {
  getClassificationHealth,
  getCloudSpend24h,
  getCloudSpendLastHour,
  getDiskFree,
  getDraftBacklogAged,
  getN8nFailures24h,
} from '@/lib/queries-system';
import { getGmailCooldown } from '@/lib/queries-system-state';

// Gathers every alert input from the live sources. Used by both the status
// route (which also surfaces the raw stats) and the alert-check push route.
export async function gatherAlertInputs(): Promise<AlertInputs> {
  const [
    draftBacklogAged,
    n8nFailures24h,
    cloudSpend24h,
    cloudSpendLastHour,
    classifyHealth,
    cooldown,
    diskFree,
  ] = await Promise.all([
    getDraftBacklogAged(DRAFT_BACKLOG_THRESHOLD_HOURS).catch(() => null),
    getN8nFailures24h(),
    getCloudSpend24h().catch(() => null),
    getCloudSpendLastHour(),
    getClassificationHealth().catch(() => null),
    getGmailCooldown().catch(() => null),
    getDiskFree('/'),
  ]);

  // Synchronous, total-failure-safe (/proc/meminfo read; returns red on error).
  const memory = checkMemoryPressure();

  return {
    draftBacklog: draftBacklogAged,
    n8nFailures: n8nFailures24h,
    cloudCostSpike:
      cloudSpendLastHour !== null && cloudSpend24h !== null
        ? {
            last_hour_usd: cloudSpendLastHour,
            trailing_24h_usd: cloudSpend24h.total_usd,
            min_trigger_usd: COST_SPIKE_MIN_TRIGGER_USD,
          }
        : null,
    memoryPressure: {
      status: memory.status,
      memAvailableGiB: memory.memAvailableGiB,
      minMemGiB: memory.minMemGiB,
    },
    gmailRateLimit: cooldown
      ? {
          active: cooldown.isActive,
          minutes_remaining: cooldown.recommended_safe_at
            ? (cooldown.recommended_safe_at.getTime() - Date.now()) / 60000
            : 0,
        }
      : null,
    classifyLag: classifyHealth
      ? { lag_minutes: lagMinutesFrom(classifyHealth.unclassifiedSince) }
      : null,
    diskFree: diskFree
      ? { free_bytes: diskFree.free_bytes, total_bytes: diskFree.total_bytes }
      : null,
  };
}

// Convenience: gather inputs and evaluate in one call.
export async function gatherFiringAlerts(): Promise<Alert[]> {
  return evaluateAlerts(await gatherAlertInputs());
}

// unclassifiedSince is an ISO timestamp string (oldest unclassified inbound) or
// null when there's no backlog. Convert to minutes-waited; null → no lag.
function lagMinutesFrom(unclassifiedSince: string | null): number | null {
  if (!unclassifiedSince) return null;
  const ms = Date.now() - new Date(unclassifiedSince).getTime();
  return Math.max(0, ms / 60000);
}
