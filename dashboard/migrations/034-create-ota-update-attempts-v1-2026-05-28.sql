-- Migration 034 — MBOX-349: per-update OTA audit log.
-- WHAT: New append-only mailbox.ota_update_attempts table. One row per
--       customer-initiated "Update now" attempt. The orchestrator
--       (POST /api/internal/ota/update-now) INSERTs a 'started' row up front
--       and UPDATEs the same row's `result` + `finished_at` as the update
--       moves through pull → recreate → migrate → smoke → commit-or-rollback.
--       from_digest/to_digest capture the Ollama-style image digests the box
--       moved between; `detail` carries the step + any error string for fleet
--       support forensics.
-- WHY:  MBOX-349 (M5 gating — NFR-6 execute half deferred from MBOX-184). The
--       read-only "update available" panel landed in MBOX-184; this is the
--       audit record for the execute path so a fleet-support session can see
--       "did the box try to update, from what to what, and did it roll back?"
--       without an SSH session. End-to-end field validation is MBOX-350.
-- ROLLBACK: DROP TABLE mailbox.ota_update_attempts; revert the orchestrator
--           route (dashboard/app/api/internal/ota/update-now/route.ts), its
--           state-machine lib (dashboard/lib/ota/update.ts), the zod schema
--           (dashboard/lib/schemas/internal.ts ota* exports), and the status
--           page "Update now" button (dashboard/app/status/page.tsx +
--           components/OtaUpdateButton.tsx). Self-contained — no data carried
--           elsewhere.

CREATE TABLE IF NOT EXISTS mailbox.ota_update_attempts (
  id          SERIAL PRIMARY KEY,
  -- The image digest the appliance was running when the attempt started, and
  -- the digest it was moving to. NULL-tolerant: a detection failure may record
  -- an attempt row before the target digest is resolvable.
  from_digest TEXT,
  to_digest   TEXT,
  -- Lifecycle of one attempt. 'started' is written at orchestration entry;
  -- exactly one terminal value (succeeded | rolled_back | failed) replaces it.
  result      TEXT NOT NULL DEFAULT 'started',
  -- Free-form step / error context for support (e.g. 'smoke failed: exit 1').
  detail      TEXT,
  -- When the attempt began; finished_at stamped on the terminal transition.
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,

  CONSTRAINT ota_update_attempts_result_check
    CHECK (result IN ('started', 'succeeded', 'rolled_back', 'failed'))
);

-- Read pattern: "most recent attempt" + history list, both ordered by recency.
CREATE INDEX IF NOT EXISTS ota_update_attempts_started_at_idx
  ON mailbox.ota_update_attempts (started_at DESC);
