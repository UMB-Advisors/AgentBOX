// STAQPRO-128 — operator-facing pipeline alerts.
//
// Pure logic: each evaluator takes a query-result-shaped input and returns
// either a single Alert or null. The route assembles inputs from
// queries-system.ts and folds the evaluator outputs into the response.
//
// Alert codes are stable wire identifiers; thresholds are defined here so
// they can be changed in one place and asserted in tests.

export type AlertSeverity = 'warn' | 'alarm';

export type AlertCode =
  | 'DRAFT_BACKLOG_AGED'
  | 'N8N_EXEC_FAILURES'
  | 'CLOUD_COST_SPIKE'
  | 'MEMORY_PRESSURE'
  | 'GMAIL_RATE_LIMITED'
  | 'CLASSIFY_LAG'
  | 'DISK_FREE_LOW';

export interface Alert {
  severity: AlertSeverity;
  code: AlertCode;
  message: string;
  value: number;
  threshold: number;
}

export const DRAFT_BACKLOG_THRESHOLD_HOURS = 4;
export const DRAFT_BACKLOG_WARN_COUNT = 0;
export const DRAFT_BACKLOG_ALARM_COUNT = 5;

export const N8N_FAILURE_RATE_WARN = 0.05;
export const N8N_FAILURE_RATE_ALARM = 0.2;

export const COST_SPIKE_MIN_TRIGGER_USD = 0.5;
export const COST_SPIKE_RATIO_WARN = 3;
export const COST_SPIKE_RATIO_ALARM = 10;

export interface DraftBacklogInput {
  aged_count: number;
  threshold_hours: number;
}

export function evaluateDraftBacklog(input: DraftBacklogInput): Alert | null {
  if (input.aged_count > DRAFT_BACKLOG_ALARM_COUNT) {
    return {
      severity: 'alarm',
      code: 'DRAFT_BACKLOG_AGED',
      message: `${input.aged_count} drafts pending > ${input.threshold_hours}h — operator approval queue stalled`,
      value: input.aged_count,
      threshold: DRAFT_BACKLOG_ALARM_COUNT,
    };
  }
  if (input.aged_count > DRAFT_BACKLOG_WARN_COUNT) {
    return {
      severity: 'warn',
      code: 'DRAFT_BACKLOG_AGED',
      message: `${input.aged_count} drafts pending > ${input.threshold_hours}h — operator approval queue lagging`,
      value: input.aged_count,
      threshold: DRAFT_BACKLOG_WARN_COUNT,
    };
  }
  return null;
}

export interface N8nFailuresInput {
  failed_count: number;
  total_count: number;
}

export function evaluateN8nFailures(input: N8nFailuresInput): Alert | null {
  if (input.total_count === 0) return null;
  const rate = input.failed_count / input.total_count;
  const pct = (rate * 100).toFixed(1);
  if (rate > N8N_FAILURE_RATE_ALARM) {
    return {
      severity: 'alarm',
      code: 'N8N_EXEC_FAILURES',
      message: `n8n execution failure rate ${pct}% (${input.failed_count}/${input.total_count}) over last 24h`,
      value: rate,
      threshold: N8N_FAILURE_RATE_ALARM,
    };
  }
  if (rate > N8N_FAILURE_RATE_WARN) {
    return {
      severity: 'warn',
      code: 'N8N_EXEC_FAILURES',
      message: `n8n execution failure rate ${pct}% (${input.failed_count}/${input.total_count}) over last 24h`,
      value: rate,
      threshold: N8N_FAILURE_RATE_WARN,
    };
  }
  return null;
}

export interface CloudCostSpikeInput {
  last_hour_usd: number;
  trailing_24h_usd: number;
  min_trigger_usd: number;
}

export function evaluateCloudCostSpike(input: CloudCostSpikeInput): Alert | null {
  if (input.last_hour_usd < input.min_trigger_usd) return null;
  const hourlyAvg = input.trailing_24h_usd / 24;
  if (hourlyAvg <= 0) return null;
  const ratio = input.last_hour_usd / hourlyAvg;
  const fmt = `$${input.last_hour_usd.toFixed(4)} in last hour — ${ratio.toFixed(1)}x trailing 24h avg ($${hourlyAvg.toFixed(4)}/hr)`;
  if (ratio > COST_SPIKE_RATIO_ALARM) {
    return {
      severity: 'alarm',
      code: 'CLOUD_COST_SPIKE',
      message: `Cloud spend ${fmt}`,
      value: ratio,
      threshold: COST_SPIKE_RATIO_ALARM,
    };
  }
  if (ratio > COST_SPIKE_RATIO_WARN) {
    return {
      severity: 'warn',
      code: 'CLOUD_COST_SPIKE',
      message: `Cloud spend ${fmt}`,
      value: ratio,
      threshold: COST_SPIKE_RATIO_WARN,
    };
  }
  return null;
}

// MBOX-166 / MBOX-109 — operator-facing memory pressure alert.
// Folds the checkMemoryPressure() helper's status into the status-page
// alerts array: red → alarm, amber → warn, green → no alert. Threshold
// value lives in lib/preflight/memory.ts (operator-tunable via
// MAILBOX_PREFLIGHT_MIN_MEM_GIB) — we don't re-declare it here.
export interface MemoryPressureInput {
  status: 'green' | 'amber' | 'red';
  memAvailableGiB: number;
  minMemGiB: number;
}

export function evaluateMemoryPressure(input: MemoryPressureInput): Alert | null {
  if (input.status === 'green') return null;
  const severity: AlertSeverity = input.status === 'red' ? 'alarm' : 'warn';
  const verb = input.status === 'red' ? 'below' : `within 200 MiB of`;
  return {
    severity,
    code: 'MEMORY_PRESSURE',
    message: `MemAvailable ${input.memAvailableGiB.toFixed(
      2,
    )} GiB ${verb} threshold ${input.minMemGiB.toFixed(2)} GiB — next large-GGUF load (classify/rag backfill) at risk of CUDA OOM`,
    value: input.memAvailableGiB,
    threshold: input.minMemGiB,
  };
}

// MBOX-185 (FR-22) — Gmail rate-limit alert. The cooldown circuit breaker
// (mailbox.system_state.gmail_rate_limit_until) is "Gmail is angry at us right
// now"; while it's active the whole send path is short-circuited, so surface it
// as an alarm-severity alert the same way memory pressure red does. value =
// minutes remaining on the recommended-safe deadline (informational only — the
// alert fires whenever active, regardless of how long is left).
export interface GmailRateLimitInput {
  active: boolean;
  minutes_remaining: number;
}

export function evaluateGmailRateLimit(input: GmailRateLimitInput): Alert | null {
  if (!input.active) return null;
  return {
    severity: 'alarm',
    code: 'GMAIL_RATE_LIMITED',
    message: `Gmail rate-limit cooldown active — sends paused for ~${Math.max(
      0,
      Math.round(input.minutes_remaining),
    )} more min (includes the STAQPRO-228 +60-min safety buffer)`,
    value: Math.max(0, input.minutes_remaining),
    threshold: 0,
  };
}

// MBOX-185 (FR-22) — classify-lag alert. Mirrors the /status page's "Classify
// lag" tile tone rule (lib/queries-system.ts:getClassificationHealth +
// app/status/page.tsx): warn when the oldest unclassified inbound has waited
// past the warn threshold, alarm past the alarm threshold. A stalled classify
// chain (n8n sub-workflow inactive after an upgrade — STAQPRO-181) is exactly
// the dark-inbox failure FR-22 should push on.
export const CLASSIFY_LAG_WARN_MINUTES = 10;
export const CLASSIFY_LAG_ALARM_MINUTES = 15;

export interface ClassifyLagInput {
  // Minutes the oldest unclassified inbound message has waited; null when there
  // is no backlog (nothing unclassified → no lag → no alert).
  lag_minutes: number | null;
}

export function evaluateClassifyLag(input: ClassifyLagInput): Alert | null {
  if (input.lag_minutes === null) return null;
  const mins = input.lag_minutes;
  if (mins > CLASSIFY_LAG_ALARM_MINUTES) {
    return {
      severity: 'alarm',
      code: 'CLASSIFY_LAG',
      message: `Oldest unclassified inbound has waited ${Math.round(
        mins,
      )} min (> ${CLASSIFY_LAG_ALARM_MINUTES}m) — classify chain may be stalled (dark inbox)`,
      value: mins,
      threshold: CLASSIFY_LAG_ALARM_MINUTES,
    };
  }
  if (mins > CLASSIFY_LAG_WARN_MINUTES) {
    return {
      severity: 'warn',
      code: 'CLASSIFY_LAG',
      message: `Oldest unclassified inbound has waited ${Math.round(
        mins,
      )} min (> ${CLASSIFY_LAG_WARN_MINUTES}m) — classify chain lagging`,
      value: mins,
      threshold: CLASSIFY_LAG_WARN_MINUTES,
    };
  }
  return null;
}

// MBOX-185 (FR-22) — disk-free alert. The 500 GB NVMe holds all email + KB +
// Qdrant + Postgres on-appliance; a full disk silently breaks ingestion and
// the vector store. Percent-free thresholds (not absolute bytes) so the rule
// holds regardless of disk size on future hardware.
export const DISK_FREE_WARN_PCT = 0.1;
export const DISK_FREE_ALARM_PCT = 0.05;

export interface DiskFreeInput {
  free_bytes: number;
  total_bytes: number;
}

export function evaluateDiskFree(input: DiskFreeInput): Alert | null {
  if (input.total_bytes <= 0) return null;
  const frac = input.free_bytes / input.total_bytes;
  const pct = (frac * 100).toFixed(1);
  const gib = (input.free_bytes / 1024 ** 3).toFixed(1);
  if (frac < DISK_FREE_ALARM_PCT) {
    return {
      severity: 'alarm',
      code: 'DISK_FREE_LOW',
      message: `Disk ${pct}% free (${gib} GiB) — below ${DISK_FREE_ALARM_PCT * 100}%; ingestion/Qdrant/Postgres at risk`,
      value: frac,
      threshold: DISK_FREE_ALARM_PCT,
    };
  }
  if (frac < DISK_FREE_WARN_PCT) {
    return {
      severity: 'warn',
      code: 'DISK_FREE_LOW',
      message: `Disk ${pct}% free (${gib} GiB) — below ${DISK_FREE_WARN_PCT * 100}%`,
      value: frac,
      threshold: DISK_FREE_WARN_PCT,
    };
  }
  return null;
}

export interface AlertInputs {
  draftBacklog: DraftBacklogInput | null;
  n8nFailures: N8nFailuresInput | null;
  cloudCostSpike: CloudCostSpikeInput | null;
  memoryPressure: MemoryPressureInput | null;
  gmailRateLimit: GmailRateLimitInput | null;
  classifyLag: ClassifyLagInput | null;
  diskFree: DiskFreeInput | null;
}

export function evaluateAlerts(inputs: AlertInputs): Alert[] {
  const alerts: Alert[] = [];
  if (inputs.draftBacklog) {
    const a = evaluateDraftBacklog(inputs.draftBacklog);
    if (a) alerts.push(a);
  }
  if (inputs.n8nFailures) {
    const a = evaluateN8nFailures(inputs.n8nFailures);
    if (a) alerts.push(a);
  }
  if (inputs.cloudCostSpike) {
    const a = evaluateCloudCostSpike(inputs.cloudCostSpike);
    if (a) alerts.push(a);
  }
  if (inputs.memoryPressure) {
    const a = evaluateMemoryPressure(inputs.memoryPressure);
    if (a) alerts.push(a);
  }
  if (inputs.gmailRateLimit) {
    const a = evaluateGmailRateLimit(inputs.gmailRateLimit);
    if (a) alerts.push(a);
  }
  if (inputs.classifyLag) {
    const a = evaluateClassifyLag(inputs.classifyLag);
    if (a) alerts.push(a);
  }
  if (inputs.diskFree) {
    const a = evaluateDiskFree(inputs.diskFree);
    if (a) alerts.push(a);
  }
  return alerts;
}
