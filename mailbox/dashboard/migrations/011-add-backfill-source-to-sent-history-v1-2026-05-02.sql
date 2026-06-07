-- 011-add-backfill-source-to-sent-history-v1-2026-05-02.sql
--
-- STAQPRO-193 — extend mailbox.sent_history so the Gmail Sent backfill
-- (reply-paired thread ingestion) can write rows for outbound messages that
-- never had a live draft on this appliance. Three changes:
--
--   1. Add message_id TEXT UNIQUE — the Gmail message ID. Lets the backfill
--      script UPSERT idempotently (per discuss-comment Locked Decision #5:
--      no cursor table; idempotency via UPSERT on message_id).
--   2. Drop the NOT NULL on draft_id and inbox_message_id. Backfill rows
--      have neither (no live draft was generated; the inbound row may exist
--      but isn't required to). Live archival path (migration 010 trigger)
--      always writes both — that path is unaffected.
--   3. Add source TEXT NOT NULL DEFAULT 'live' with CHECK (source IN
--      ('live','backfill')). Discriminator so persona extraction
--      (STAQPRO-153) and any future read paths can keep behavior aligned —
--      backfilled rows are real outbound voice but lack live-pipeline
--      metadata (no live draft_original, no real classification).
--
-- Why this shape over a separate sent_history_backfill table:
--   - Persona extraction (lib/persona/extract.ts) reads sent_history; one
--     table = no fan-out. Discriminator column is enough.
--   - rag-backfill.ts already reads sent_history; one table keeps that
--     query unchanged (modulo selecting message_id when present).
--
-- Reversal: drop the unique index, drop source, restore NOT NULLs (only safe
-- if no backfill rows exist). The constraint widening is forward-compatible.

-- (1) message_id for idempotent UPSERT.
ALTER TABLE mailbox.sent_history
  ADD COLUMN IF NOT EXISTS message_id TEXT;

-- Partial unique index — only enforced where message_id is present, so
-- pre-existing rows (without message_id) don't trip the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS sent_history_message_id_unique
  ON mailbox.sent_history(message_id)
  WHERE message_id IS NOT NULL;

-- (2) Relax NOT NULL on draft_id + inbox_message_id for backfill rows.
ALTER TABLE mailbox.sent_history
  ALTER COLUMN draft_id DROP NOT NULL;
ALTER TABLE mailbox.sent_history
  ALTER COLUMN inbox_message_id DROP NOT NULL;

-- (3) Source discriminator. Default 'live' so existing rows are stamped
-- correctly without a backfill UPDATE.
ALTER TABLE mailbox.sent_history
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'live';

ALTER TABLE mailbox.sent_history
  DROP CONSTRAINT IF EXISTS sent_history_source_check;
ALTER TABLE mailbox.sent_history
  ADD CONSTRAINT sent_history_source_check
  CHECK (source = ANY (ARRAY['live','backfill']));

CREATE INDEX IF NOT EXISTS sent_history_source_idx
  ON mailbox.sent_history(source);
