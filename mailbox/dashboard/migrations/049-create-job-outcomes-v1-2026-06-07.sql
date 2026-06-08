-- Migration 049 — MBOX-462: Agent Job outcomes ledger (per company/department).
-- WHAT: new mailbox.job_outcomes table. One row per *outcome* produced by an
--       agent job run (a draft, report, blog post, message). v1 source =
--       hermes-agent cron jobs (executed via gbrain minions), which already
--       carry a `profile` (company) and a `department_id` soft-referencing the
--       CRM (migration 047/048). The row resolves `profile` → businesses.id and
--       carries department_id so the Daily Brief can roll outcomes up per
--       Business and per Department.
-- WHY:  operator request (2026-06-07) — "the results of the jobs (drafts,
--       reports, outcomes) need to be in the daily brief, per company, per
--       department." Today job outcomes are *delivered* (email/draft/kanban) but
--       never recorded in a queryable form. This is the ledger; emitters POST to
--       /api/internal/job-outcomes. Raw-pg / company-wide domain like the CRM
--       (lib/crm) — intentionally NOT in the Kysely codegen / account scope.
-- ROLLBACK: DROP TABLE mailbox.job_outcomes; then revert the queries
--           (lib/job-outcomes), the route (app/api/internal/job-outcomes), the
--           zod schema (lib/schemas/job-outcomes), and the digest wiring
--           (lib/queries-digest.ts + lib/digest/render.ts). No data carried
--           elsewhere — outcomes are an append-only audit surface.

CREATE TABLE IF NOT EXISTS mailbox.job_outcomes (
  id              BIGSERIAL PRIMARY KEY,
  -- Producing subsystem. Open TEXT (no CHECK) — a new source must not need a
  -- migration. v1 known values: 'hermes_cron' | 'gbrain_minion'.
  source          TEXT NOT NULL,
  -- The job's stable id in its own store (hermes cron job id / gbrain minion id)
  -- + a human label. Soft references — the cron store and this ledger are
  -- separate systems, so no FK.
  external_job_id TEXT,
  job_name        TEXT NOT NULL,
  -- Company attribution. `profile` is the hermes profile name as emitted;
  -- business_id is the resolved CRM business. NULL business_id = profile not
  -- mapped to a known business yet (outcome still recorded, shows as Unassigned).
  profile         TEXT,
  business_id     INTEGER REFERENCES mailbox.businesses(id) ON DELETE SET NULL,
  -- Department attribution — the same CRM department the cron job already
  -- carries (hermes cron department_id → mailbox.departments).
  department_id   INTEGER REFERENCES mailbox.departments(id) ON DELETE SET NULL,
  -- What the job produced. Open TEXT; the brief groups by it. Known:
  -- 'draft' | 'report' | 'blog_post' | 'message' | 'other'.
  outcome_type    TEXT NOT NULL DEFAULT 'other',
  -- Did it succeed? Closed enum — kept in lockstep with JOB_OUTCOME_STATUSES in
  -- lib/job-outcomes/queries.ts.
  status          TEXT NOT NULL DEFAULT 'success',
  title           TEXT NOT NULL DEFAULT '',
  summary         TEXT NOT NULL DEFAULT '',
  -- Where the artifact lives (draft id, url, doc path…) — opaque to the brief,
  -- surfaced as a ref. '{}' (not NULL) for the empty case.
  artifact_ref    JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- When the job produced it (emitter-supplied). created_at = ingest time.
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT job_outcomes_status_check
    CHECK (status IN ('success', 'partial', 'failed', 'skipped'))
);

-- Brief reads are "outcomes since T, grouped by business then department" —
-- index the two grouping keys by recency so the daily rollup scan is cheap.
CREATE INDEX IF NOT EXISTS job_outcomes_business_occurred_idx
  ON mailbox.job_outcomes (business_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS job_outcomes_department_occurred_idx
  ON mailbox.job_outcomes (department_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS job_outcomes_occurred_idx
  ON mailbox.job_outcomes (occurred_at DESC);
