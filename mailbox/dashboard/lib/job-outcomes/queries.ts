import { getPool } from '@/lib/db';

// MBOX-462 — Agent Job outcomes ledger (migration 049). Raw pg via getPool(),
// matching lib/crm (company-wide, not account-scoped, outside Kysely codegen).
//
// An *outcome* is one artifact an agent job produced (a draft, report, blog
// post, message). v1 emitters are hermes-agent cron jobs (run via gbrain
// minions), which already carry a `profile` (company) and `department_id`
// (→ CRM). The Daily Brief rolls these up per Business then per Department.

// Closed enum — keep in lockstep with the migration-049 CHECK
// (job_outcomes_status_check).
export const JOB_OUTCOME_STATUSES = ['success', 'partial', 'failed', 'skipped'] as const;
export type JobOutcomeStatus = (typeof JOB_OUTCOME_STATUSES)[number];

export interface JobOutcome {
  id: string; // BIGSERIAL → pg returns bigint as string
  source: string;
  external_job_id: string | null;
  job_name: string;
  profile: string | null;
  business_id: number | null;
  department_id: number | null;
  outcome_type: string;
  status: JobOutcomeStatus;
  title: string;
  summary: string;
  artifact_ref: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}

export interface RecordJobOutcomeInput {
  source: string;
  external_job_id?: string | null;
  job_name: string;
  profile?: string | null;
  business_id?: number | null;
  department_id?: number | null;
  outcome_type?: string;
  status?: JobOutcomeStatus;
  title?: string;
  summary?: string;
  artifact_ref?: Record<string, unknown>;
  occurred_at?: string | null;
}

// Normalize a name for fuzzy profile→business matching: lowercase, drop
// everything but alphanumerics ('Yes Cacao' / 'yes-cacao' / 'yes_cacao' → 'yescacao').
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Best-effort: resolve a hermes profile name to a CRM business id. Exact-name
// first (cheap, indexed by UNIQUE(name)), then a normalized scan. Returns null
// when nothing matches — the outcome is still recorded as Unassigned.
export async function resolveBusinessIdByProfile(profile: string): Promise<number | null> {
  const pool = getPool();
  const exact = await pool.query<{ id: number }>(
    'SELECT id FROM mailbox.businesses WHERE lower(name) = lower($1) LIMIT 1',
    [profile],
  );
  if (exact.rows[0]) return exact.rows[0].id;

  const target = normalizeName(profile);
  if (!target) return null;
  const all = await pool.query<{ id: number; name: string }>(
    'SELECT id, name FROM mailbox.businesses',
  );
  const hit = all.rows.find((b) => normalizeName(b.name) === target);
  return hit?.id ?? null;
}

// Insert one outcome. business_id is taken as-given, else resolved from
// `profile`. occurred_at defaults to NOW() at the DB. Returns the stored row.
export async function recordJobOutcome(input: RecordJobOutcomeInput): Promise<JobOutcome> {
  const businessId =
    input.business_id ?? (input.profile ? await resolveBusinessIdByProfile(input.profile) : null);

  const { rows } = await getPool().query<JobOutcome>(
    `INSERT INTO mailbox.job_outcomes
       (source, external_job_id, job_name, profile, business_id, department_id,
        outcome_type, status, title, summary, artifact_ref, occurred_at)
     VALUES
       ($1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11::jsonb, COALESCE($12::timestamptz, NOW()))
     RETURNING *`,
    [
      input.source,
      input.external_job_id ?? null,
      input.job_name,
      input.profile ?? null,
      businessId,
      input.department_id ?? null,
      input.outcome_type ?? 'other',
      input.status ?? 'success',
      input.title ?? '',
      input.summary ?? '',
      JSON.stringify(input.artifact_ref ?? {}),
      input.occurred_at ?? null,
    ],
  );
  return rows[0];
}

// ── Per-company / per-department rollup (the Daily Brief surface) ────────────

export interface OutcomeCounts {
  total: number;
  success: number;
  partial: number;
  failed: number;
  skipped: number;
}

export interface OutcomeBriefItem {
  id: string;
  source: string;
  job_name: string;
  outcome_type: string;
  status: JobOutcomeStatus;
  title: string;
  occurred_at: string;
}

export interface DepartmentRollup {
  department_id: number | null;
  department_name: string; // 'Unassigned' when department_id is null
  counts: OutcomeCounts;
  by_type: Record<string, number>;
  recent: OutcomeBriefItem[];
}

export interface BusinessRollup {
  business_id: number | null;
  business_name: string; // 'Unassigned' when business_id is null
  counts: OutcomeCounts;
  departments: DepartmentRollup[];
}

export interface OutcomesRollup {
  since_hours: number;
  total: number;
  businesses: BusinessRollup[];
}

interface OutcomeJoinRow extends JobOutcome {
  business_name: string | null;
  department_name: string | null;
}

const UNASSIGNED = 'Unassigned';

function emptyCounts(): OutcomeCounts {
  return { total: 0, success: 0, partial: 0, failed: 0, skipped: 0 };
}

function tally(counts: OutcomeCounts, status: JobOutcomeStatus): void {
  counts.total += 1;
  counts[status] += 1;
}

export interface OutcomesRollupOptions {
  sinceHours?: number;
  recentPerDepartment?: number;
  // Hard cap on rows scanned (a daily brief is small; this is a safety bound).
  maxRows?: number;
}

// Build the Business → Department rollup of outcomes since a cutoff. One scan +
// JS grouping (the daily-brief volume is small and this keeps the shape easy to
// test). NULL business/department fold into a single 'Unassigned' bucket each;
// businesses sort by total desc then name, departments likewise.
export async function getOutcomesRollup(opts: OutcomesRollupOptions = {}): Promise<OutcomesRollup> {
  const sinceHours = Math.min(Math.max(Math.trunc(opts.sinceHours ?? 24) || 24, 1), 24 * 30);
  const recentPerDept = Math.min(Math.max(Math.trunc(opts.recentPerDepartment ?? 5) || 5, 1), 50);
  const maxRows = Math.min(Math.max(Math.trunc(opts.maxRows ?? 1000) || 1000, 1), 5000);

  const { rows } = await getPool().query<OutcomeJoinRow>(
    `SELECT o.*, b.name AS business_name, d.name AS department_name
       FROM mailbox.job_outcomes o
       LEFT JOIN mailbox.businesses  b ON o.business_id   = b.id
       LEFT JOIN mailbox.departments d ON o.department_id = d.id
      WHERE o.occurred_at >= NOW() - ($1 || ' hours')::interval
      ORDER BY o.occurred_at DESC
      LIMIT $2`,
    [String(sinceHours), maxRows],
  );

  // bizKey/deptKey use the id when present, else a sentinel for the Unassigned
  // bucket, so null-business and null-department rows aggregate together.
  const businesses = new Map<string, BusinessRollup>();

  for (const r of rows) {
    const bizKey = r.business_id === null ? 'b:null' : `b:${r.business_id}`;
    let biz = businesses.get(bizKey);
    if (!biz) {
      biz = {
        business_id: r.business_id,
        business_name: r.business_name ?? UNASSIGNED,
        counts: emptyCounts(),
        departments: [],
      };
      businesses.set(bizKey, biz);
    }
    tally(biz.counts, r.status);

    const deptKey = r.department_id === null ? 'd:null' : `d:${r.department_id}`;
    let dept = biz.departments.find((d) => deptKeyOf(d) === deptKey);
    if (!dept) {
      dept = {
        department_id: r.department_id,
        department_name: r.department_name ?? UNASSIGNED,
        counts: emptyCounts(),
        by_type: {},
        recent: [],
      };
      biz.departments.push(dept);
    }
    tally(dept.counts, r.status);
    dept.by_type[r.outcome_type] = (dept.by_type[r.outcome_type] ?? 0) + 1;
    if (dept.recent.length < recentPerDept) {
      dept.recent.push({
        id: r.id,
        source: r.source,
        job_name: r.job_name,
        outcome_type: r.outcome_type,
        status: r.status,
        title: r.title,
        occurred_at: r.occurred_at,
      });
    }
  }

  const ordered = [...businesses.values()].sort(
    byCountThenName(
      (b) => b.business_name,
      (b) => b.counts.total,
    ),
  );
  for (const b of ordered) {
    b.departments.sort(
      byCountThenName(
        (d) => d.department_name,
        (d) => d.counts.total,
      ),
    );
  }

  return { since_hours: sinceHours, total: rows.length, businesses: ordered };
}

function deptKeyOf(d: DepartmentRollup): string {
  return d.department_id === null ? 'd:null' : `d:${d.department_id}`;
}

// Sort by total desc, then name asc — Unassigned (a label) sorts naturally.
function byCountThenName<T>(name: (t: T) => string, total: (t: T) => number) {
  return (a: T, b: T): number => total(b) - total(a) || name(a).localeCompare(name(b));
}
