// dashboard/lib/jobs/gmail-ratelimit-sweeper.ts
//
// STAQPRO-227 stretch — system-wide Gmail cooldown writer.
//
// Tick (every 60s via instrumentation.ts):
//   1. Acquire single-process advisory lock so overlapping ticks can't
//      double-write.
//   2. Scan n8n's execution_entity for status='error' executions on
//      Gmail-touching workflows (MailBOX parent + mailbox-send) in the
//      last 5 minutes.
//   3. Extract "Retry after <ISO>" from execution_data.data with a regex.
//      Google embeds the hint verbatim in the 429 body; n8n stores it
//      whole in the serialized error.
//   4. If the latest hint is in the future AND beyond the currently-set
//      gmail_rate_limit_until, advance the cooldown via setGmailCooldown
//      (idempotent — uses GREATEST so older timestamps are no-ops).
//
// Reads cross-schema (n8n's `execution_entity` + `execution_data` live
// alongside our `mailbox.*` tables in the same Postgres). Sweeper is
// read-only against n8n's tables; only writes to `mailbox.system_state`.
//
// Why every 60s: Google's 429 retry-after hints are minute-grained; faster
// polling buys us nothing. Slower polling means the schedule trigger could
// fire one cycle into a probation period before we catch it.
//
// Why not n8n MCP get_execution: would require an HTTP roundtrip per
// errored execution, plus the MCP server isn't part of the appliance
// runtime guarantees. Direct Postgres read is what classify-sweeper does
// and matches the existing pattern.

import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import { withJobRun } from '@/lib/jobs/job-runs';
import { setGmailCooldown } from '@/lib/queries-system-state';

const LOCK_KEY = 7234568; // adjacent to classify-sweeper's 7234567
const LOOKBACK_MINUTES = 5;
const DEFAULT_INTERVAL_MS = 60 * 1000;

// Workflow IDs that touch Gmail. MailBOX parent uses Gmail Get; mailbox-send
// uses Gmail Reply. Both share the same per-user quota.
const GMAIL_WORKFLOW_IDS = ['C3kG7uKyRgxXpcJv', 'mailbox-send'] as const;

interface SweeperResult {
  scanned: number;
  hint: string | null;
  applied: boolean;
}

export async function runGmailRatelimitSweeperTick(): Promise<SweeperResult> {
  const db = getKysely();
  const result: SweeperResult = { scanned: 0, hint: null, applied: false };

  const lock = await sql<{ acquired: boolean }>`
    SELECT pg_try_advisory_lock(${LOCK_KEY}) AS acquired
  `.execute(db);
  if (!lock.rows[0]?.acquired) {
    return result;
  }

  try {
    // Find the latest "Retry after <ISO>" hint across recent errored
    // Gmail executions. Postgres `substring(text FROM pattern)` returns
    // the matched substring or NULL. We regex-extract the timestamp,
    // cast to timestamptz, and pick the maximum.
    const rows = await sql<{ scanned: number; latest: string | null }>`
      WITH gmail_errors AS (
        SELECT
          e.id,
          d.data,
          substring(d.data FROM 'Retry after [0-9T:.Z\\-]+') AS hint
        FROM execution_entity e
        JOIN execution_data d ON d."executionId" = e.id
        WHERE e."workflowId" = ANY (${sql.lit(`{${GMAIL_WORKFLOW_IDS.join(',')}}`)})
          AND e.status = 'error'
          AND e."startedAt" > NOW() - make_interval(mins => ${LOOKBACK_MINUTES})
      )
      SELECT
        COUNT(*)::int AS scanned,
        MAX(
          CASE
            WHEN hint IS NULL THEN NULL
            ELSE (substring(hint FROM '[0-9][0-9TZ:.\\-]+'))::timestamptz
          END
        )::text AS latest
      FROM gmail_errors
    `.execute(db);

    const row = rows.rows[0];
    result.scanned = row?.scanned ?? 0;
    result.hint = row?.latest ?? null;

    if (row?.latest) {
      const until = new Date(row.latest);
      // Only set if the hint is actually in the future — Google's hint
      // is sometimes tiny (a few seconds) and the value of the cooldown
      // is preventing IMMEDIATE re-fire, so writing a past timestamp is
      // a no-op anyway.
      if (until.getTime() > Date.now()) {
        await setGmailCooldown(until);
        result.applied = true;
      }
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`.execute(db);
  }

  if (result.applied) {
    console.log(`[gmail-ratelimit-sweeper] cooldown set: until=${result.hint}`);
  }
  return result;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startGmailRatelimitSweeper(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (intervalHandle) return;
  console.log(`[gmail-ratelimit-sweeper] starting (interval=${intervalMs}ms)`);
  intervalHandle = setInterval(() => {
    withJobRun('gmail-ratelimit-sweeper', runGmailRatelimitSweeperTick).catch((e: unknown) => {
      console.error(
        '[gmail-ratelimit-sweeper] tick error:',
        e instanceof Error ? e.message : String(e),
      );
    });
  }, intervalMs);
}
