-- 005-create-persona-v1-2026-04-27.sql
-- Voice profile (D-11): one row per customer_key.

CREATE TABLE IF NOT EXISTS mailbox.persona (
  id                  SERIAL PRIMARY KEY,
  customer_key        TEXT NOT NULL DEFAULT 'default',
  statistical_markers JSONB NOT NULL DEFAULT '{}'::jsonb,
  category_exemplars  JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_email_count  INTEGER NOT NULL DEFAULT 0,
  last_refreshed_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS persona_customer_key_uq
  ON mailbox.persona(customer_key);
