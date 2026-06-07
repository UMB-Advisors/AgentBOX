// dashboard/lib/jobs/job-runs.ts
//
// Audit-log helper for in-process sweepers (audit 2026-05-15).
//
// Each sweeper tick is wrapped in `withJobRun(jobName, fn)`; the wrapper
// runs the tick, derives a status from the result shape, and writes one
// row into `mailbox.job_runs`. Failures inside the tick are caught,
// recorded as `status='failed'`, and re-thrown — the outer setInterval
// guards already catch and log; this keeps the existing crash semantics.
//
// Status derivation:
//   - tick throws                                  → 'failed'
//   - result has `failed` or `retry_failed` >= 1   → 'partial'
//   - result.checked === 0 (advisory lock missed
//      OR no work)                                 → 'skipped' (only
//      when the sweeper explicitly returned a {checked:0} that means
//      "lock not acquired" — see runWithLockMarker variant below)
//   - otherwise                                    → 'completed'
//
// Keep the write fire-and-forget on a separate pool client so an audit
// failure NEVER takes down a working tick. RAG-shaped pattern: the
// audit is augmentation, not gate.

import { sql } from 'kysely';
import { getKysely } from '@/lib/db';

export type JobStatus = 'completed' | 'partial' | 'failed' | 'skipped';

interface SweeperResultShape {
  // classify-sweeper + stuck-stub-sweeper use `checked`.
  // gmail-ratelimit-sweeper uses `scanned`. Either is treated as
  // "rows_processed" for the audit summary.
  checked?: number;
  scanned?: number;
  // classify-sweeper + stuck-stub-sweeper
  failed?: number;
  // stuck-stub-sweeper
  retry_failed?: number;
}

function deriveStatus(result: SweeperResultShape, lockSkipped: boolean): JobStatus {
  if (lockSkipped) return 'skipped';
  const failed = (result.failed ?? 0) + (result.retry_failed ?? 0);
  if (failed > 0) return 'partial';
  return 'completed';
}

function deriveRowsProcessed(result: SweeperResultShape): number {
  return result.checked ?? result.scanned ?? 0;
}

export interface WithJobRunOptions {
  /**
   * If provided, the wrapper inspects `result[lockSkipMarker]` and treats
   * a truthy value as "advisory lock was held by another instance" — status
   * is recorded as 'skipped' instead of 'completed'. The default behavior
   * (no marker) is to call all zero-checked results 'completed' (nothing
   * to do, not skipped).
   */
  lockSkipMarker?: string;
}

const HOST = process.env.HOSTNAME ?? null;

async function insertJobRun(
  jobName: string,
  startedAt: Date,
  finishedAt: Date,
  status: JobStatus,
  rowsProcessed: number,
  resultJson: unknown,
  errorMessage: string | null,
): Promise<void> {
  const db = getKysely();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  try {
    await sql`
      INSERT INTO mailbox.job_runs
        (job_name, started_at, finished_at, duration_ms, status,
         rows_processed, result_json, error_message, host)
      VALUES
        (${jobName}, ${startedAt.toISOString()}, ${finishedAt.toISOString()},
         ${durationMs}, ${status}, ${rowsProcessed},
         ${JSON.stringify(resultJson ?? null)}::jsonb,
         ${errorMessage}, ${HOST})
    `.execute(db);
  } catch (e) {
    // Audit write failure must NEVER take down a working sweeper tick.
    console.error(
      `[job-runs] insert failed for ${jobName}:`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Wrap a sweeper tick function with job-run audit logging.
 *
 * The tick fn is called, its return value is preserved, and one row is
 * inserted into mailbox.job_runs reflecting the outcome. If the tick
 * throws, status='failed' is recorded with the error message and the
 * error is re-thrown so the outer setInterval guard logs it normally.
 */
export async function withJobRun<R extends SweeperResultShape>(
  jobName: string,
  fn: () => Promise<R>,
  opts: WithJobRunOptions = {},
): Promise<R> {
  const startedAt = new Date();
  try {
    const result = await fn();
    const finishedAt = new Date();
    const lockSkipped = opts.lockSkipMarker
      ? Boolean((result as Record<string, unknown>)[opts.lockSkipMarker])
      : false;
    const status = deriveStatus(result, lockSkipped);
    const rowsProcessed = deriveRowsProcessed(result);
    await insertJobRun(jobName, startedAt, finishedAt, status, rowsProcessed, result, null);
    return result;
  } catch (e) {
    const finishedAt = new Date();
    const errorMessage = e instanceof Error ? e.message : String(e);
    await insertJobRun(jobName, startedAt, finishedAt, 'failed', 0, null, errorMessage);
    throw e;
  }
}
