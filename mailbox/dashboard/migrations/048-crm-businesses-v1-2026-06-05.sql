-- Migration 048 — AgentBOX CRM: Businesses; departments belong to a business.
-- WHAT: new mailbox.businesses table (the entities the operator runs — Heron
--       Labs, STATE, etc.) + a nullable business_id on mailbox.departments.
-- WHY:  operator request (2026-06-05). Departments are created per-business in
--       the Settings > Businesses section. Existing departments keep
--       business_id NULL (unassigned) until edited.
-- ROLLBACK: ALTER TABLE mailbox.departments DROP COLUMN business_id;
--           DROP TABLE mailbox.businesses; then revert lib/crm + app/api/crm/businesses.

CREATE TABLE IF NOT EXISTS mailbox.businesses (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE mailbox.departments
  ADD COLUMN IF NOT EXISTS business_id INTEGER
  REFERENCES mailbox.businesses(id) ON DELETE SET NULL;
