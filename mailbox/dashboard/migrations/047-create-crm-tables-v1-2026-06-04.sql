-- Migration 047 — AgentBOX CRM: Departments, Team (humans+agents), Contacts.
-- WHAT: three new tables in the mailbox schema backing the dashboard's new Team
--       and Contacts tabs, plus the Scheduled Actions Department/Employee
--       assignment. Company-wide (NOT account-scoped) — they describe the
--       operator's org, not a single mailbox account.
-- WHY:  operator request (2026-06-04). Team = humans + agents in the company.
--       Contacts = a managed CRM (phone/email/social), DISTINCT from the
--       read-only Google People panel at /api/contacts (MBOX-398); the CRM may
--       later import People rows (source='google', external_id = resourceName).
-- ROLLBACK: DROP TABLE mailbox.crm_contacts, mailbox.team_members,
--           mailbox.departments CASCADE; then revert lib/crm/* and app/api/crm/*.

CREATE TABLE IF NOT EXISTS mailbox.departments (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mailbox.team_members (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'human',   -- 'human' | 'agent'
  title         TEXT NOT NULL DEFAULT '',
  department_id INTEGER REFERENCES mailbox.departments(id) ON DELETE SET NULL,
  email         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'inactive'
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mailbox.crm_contacts (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  company     TEXT NOT NULL DEFAULT '',
  phones      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- string[]
  emails      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- string[]
  socials     JSONB NOT NULL DEFAULT '[]'::jsonb,  -- {platform,handle}[]
  tags        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- string[]
  notes       TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'manual',      -- 'manual' | 'google'
  external_id TEXT,                                 -- Google People resourceName (import dedup)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dedup imported contacts per source (manual rows keep external_id NULL).
CREATE UNIQUE INDEX IF NOT EXISTS crm_contacts_source_external_uniq
  ON mailbox.crm_contacts (source, external_id) WHERE external_id IS NOT NULL;
