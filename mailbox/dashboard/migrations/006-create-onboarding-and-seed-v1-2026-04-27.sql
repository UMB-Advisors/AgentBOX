-- 006-create-onboarding-and-seed-v1-2026-04-27.sql
-- Onboarding state machine (D-16). 6 stages enforced via CHECK.

CREATE TABLE IF NOT EXISTS mailbox.onboarding (
  id                     SERIAL PRIMARY KEY,
  customer_key           TEXT NOT NULL DEFAULT 'default',
  stage                  TEXT NOT NULL DEFAULT 'pending_admin',
  admin_username         TEXT,
  admin_password_hash    TEXT,
  email_address          TEXT,
  ingest_progress_total  INTEGER,
  ingest_progress_done   INTEGER NOT NULL DEFAULT 0,
  tuning_sample_count    INTEGER NOT NULL DEFAULT 0,
  tuning_rated_count     INTEGER NOT NULL DEFAULT 0,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lived_at               TIMESTAMPTZ,
  CONSTRAINT onboarding_stage_check CHECK (stage = ANY (ARRAY[
    'pending_admin',
    'pending_email',
    'ingesting',
    'pending_tuning',
    'tuning_in_progress',
    'live'
  ]))
);

CREATE UNIQUE INDEX IF NOT EXISTS onboarding_customer_key_uq
  ON mailbox.onboarding(customer_key);
CREATE INDEX IF NOT EXISTS onboarding_stage_idx
  ON mailbox.onboarding(stage);

INSERT INTO mailbox.onboarding (customer_key, stage)
VALUES ('default', 'pending_admin')
ON CONFLICT (customer_key) DO NOTHING;
