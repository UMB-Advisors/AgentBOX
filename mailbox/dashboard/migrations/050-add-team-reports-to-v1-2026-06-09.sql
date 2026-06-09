-- 050: add reporting hierarchy to team members (Org Chart graph).
-- Self-referential FK: a member reports_to another member. ON DELETE SET NULL
-- so removing a manager orphans reports to the root rather than cascading.
-- Idempotent + additive — safe to re-run.

ALTER TABLE mailbox.team_members
  ADD COLUMN IF NOT EXISTS reports_to INTEGER
  REFERENCES mailbox.team_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_team_members_reports_to
  ON mailbox.team_members(reports_to);
