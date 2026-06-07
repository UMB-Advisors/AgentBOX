-- Migration 026 — MBOX-133: server-side persistence for operator filter/sort prefs.
-- WHAT: New mailbox.user_filter_preferences table. One row per (operator_id, key)
--       where `key` is a dotted namespace like 'queue.filters' / 'queue.sort'
--       and `value` is the opaque JSON blob the dashboard stores for that key.
--       Lets the queue's filter-chip + sort selection survive a page refresh
--       (GET/PUT /api/operator/preferences/[key]).
-- WHY:  MBOX-133 (Phase 2c, parent STAQPRO-403 triage-UX). The sandbox filter
--       UI (MBOX-128) shipped client-only state; this gives it a durable home.
--       operator_id is nullable now (default NULL = the single-operator-per-
--       appliance era) so future per-user keying lands without a breaking
--       migration — the uniqueness key already includes operator_id.
-- ROLLBACK: DROP TABLE mailbox.user_filter_preferences; revert the GET/PUT
--           routes (dashboard/app/api/operator/preferences/[key]/route.ts),
--           the queries (dashboard/lib/queries-preferences.ts), and the sandbox
--           usePreference() hook wiring in sandbox/src/App.tsx.

CREATE TABLE IF NOT EXISTS mailbox.user_filter_preferences (
  id           SERIAL PRIMARY KEY,
  -- NULL = the single-operator-per-appliance default. A future multi-operator
  -- migration sets this per operator; the unique indexes below keep both worlds
  -- collision-free without a schema break.
  operator_id  TEXT,
  -- Dotted preference namespace, e.g. 'queue.filters', 'queue.sort'. Free-form
  -- TEXT at the DB layer; the route's zod schema enforces the allowed shape.
  key          TEXT NOT NULL,
  value        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT user_filter_preferences_key_not_blank CHECK (length(trim(key)) > 0)
);

-- Single-row-per-key for the single-operator (operator_id IS NULL) world. A
-- plain UNIQUE(operator_id, key) would NOT enforce this because Postgres treats
-- NULLs as distinct — so the NULL-operator case needs its own partial index.
CREATE UNIQUE INDEX IF NOT EXISTS user_filter_preferences_default_key_uidx
  ON mailbox.user_filter_preferences(key)
  WHERE operator_id IS NULL;

-- One-row-per-(operator, key) for the future per-operator world.
CREATE UNIQUE INDEX IF NOT EXISTS user_filter_preferences_operator_key_uidx
  ON mailbox.user_filter_preferences(operator_id, key)
  WHERE operator_id IS NOT NULL;
