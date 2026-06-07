-- Migration 024 — Audit 2026-05-15: job_runs audit table for in-process sweepers.
-- WHAT: New mailbox.job_runs append-only audit table. One row per completed
--       sweeper tick (classify-sweeper, gmail-ratelimit-sweeper,
--       stuck-stub-sweeper). Captures started_at/finished_at, status,
--       rows_processed, per-job result_json shape, and error_message.
-- WHY:  Liotta + Neo Architect (2026-05-15 multi-agent audit) both flagged
--       "in-process sweepers are stealth ops" — three sweepers run via
--       experimental.instrumentationHook with no audit surface. By
--       customer #5 this is unobservable. job_runs is the minimum viable
--       observability: feeds /api/system/status (FR-29) so the operator
--       sees last-N runs per job + failure detail without SSHing to logs.
-- ROLLBACK: DROP TABLE mailbox.job_runs; remove the writes in
--           dashboard/lib/jobs/job-runs.ts and the three sweepers; revert
--           queries-system.ts getJobHealth().
-- RETENTION: not pruned in v1. Append-only volume: classify-sweeper +
--           stuck-stub at 5min × 12/hr = 288/day each; gmail-ratelimit at
--           60/hr × 24 = 1440/day. ~2000 rows/day total. A retention
--           sweeper (or weekly DELETE WHERE finished_at < NOW() - 30 days)
--           is a follow-up; for v1, manual cleanup is fine.

CREATE TABLE IF NOT EXISTS mailbox.job_runs (
  id              BIGSERIAL PRIMARY KEY,
  job_name        TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ NOT NULL,
  duration_ms     INTEGER NOT NULL,
  status          TEXT NOT NULL,
  rows_processed  INTEGER NOT NULL DEFAULT 0,
  result_json     JSONB,
  error_message   TEXT,
  host            TEXT,

  -- Closed enum. 'skipped' = advisory lock was held by another in-process
  -- instance (process startup race, double-instrumentation under HMR);
  -- 'completed' = tick ran clean; 'partial' = some rows failed but tick
  -- itself completed; 'failed' = tick threw (caught by the setInterval
  -- guard or the wrapper).
  CONSTRAINT job_runs_status_check CHECK (
    status IN ('completed', 'partial', 'failed', 'skipped')
  )
);

-- Fast "last N runs per job" — the only read pattern from /status.
CREATE INDEX IF NOT EXISTS job_runs_job_name_started_at_idx
  ON mailbox.job_runs(job_name, started_at DESC);

-- Fast "any failures in the last 24h" — alerting + dashboard health chip.
CREATE INDEX IF NOT EXISTS job_runs_failures_idx
  ON mailbox.job_runs(finished_at DESC)
  WHERE status IN ('failed', 'partial');
