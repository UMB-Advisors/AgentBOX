-- Migration 021 — STAQPRO-244: keep mailbox.inbox_messages denormalized
-- columns in sync with their authoritative sources via Postgres triggers.
-- WHAT: Two AFTER INSERT triggers on mailbox.classification_log and
--       mailbox.drafts that backfill mailbox.inbox_messages.{classification,
--       confidence, classified_at, model, draft_id}. The columns existed
--       and were documented as "the message-level snapshot of the latest
--       classification" but no n8n workflow node ever wrote them — only 10
--       of 951 rows on M1 had values, all from a one-shot manual backfill.
-- WHY:  STAQPRO-244 audit found dashboard/lib/queries.ts and rag-eval-harness
--       read these columns. UI doesn't currently consume them, but the
--       eval harness counts everything as "unclassified" because the column
--       is NULL — making the harness output meaningless. Backfill on M1
--       just landed; this migration ensures the invariant holds going forward
--       without an n8n workflow JSON edit (low-risk schema-level fix vs
--       touching the live customer #1 classify path).
-- REVERSAL: DROP TRIGGER trg_sync_inbox_from_classification_log ON
--           mailbox.classification_log;
--           DROP TRIGGER trg_sync_inbox_draft_id ON mailbox.drafts;
--           DROP FUNCTION mailbox.sync_inbox_from_classification_log();
--           DROP FUNCTION mailbox.sync_inbox_draft_id();
--           Inbox_messages denorm columns retain their last-trigger-fired
--           values (no data loss). Subsequent classifies leave them stale.

CREATE OR REPLACE FUNCTION mailbox.sync_inbox_from_classification_log()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE mailbox.inbox_messages
  SET classification = NEW.category,
      confidence = NEW.confidence::numeric(4,3),
      classified_at = NEW.created_at,
      model = NEW.model_version
  WHERE id = NEW.inbox_message_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mailbox.sync_inbox_draft_id()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE mailbox.inbox_messages
  SET draft_id = NEW.id
  WHERE id = NEW.inbox_message_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_inbox_from_classification_log
  ON mailbox.classification_log;
CREATE TRIGGER trg_sync_inbox_from_classification_log
  AFTER INSERT ON mailbox.classification_log
  FOR EACH ROW
  EXECUTE FUNCTION mailbox.sync_inbox_from_classification_log();

DROP TRIGGER IF EXISTS trg_sync_inbox_draft_id
  ON mailbox.drafts;
CREATE TRIGGER trg_sync_inbox_draft_id
  AFTER INSERT ON mailbox.drafts
  FOR EACH ROW
  EXECUTE FUNCTION mailbox.sync_inbox_draft_id();

-- One-shot backfill for any rows that were inserted before the triggers
-- existed. Idempotent (IS DISTINCT FROM short-circuits on already-correct
-- rows). On M1 this landed +105 classification rows + 65 draft_id rows
-- pre-migration; subsequent applies are no-ops.

WITH latest AS (
  SELECT DISTINCT ON (inbox_message_id)
    inbox_message_id, category, confidence, created_at, model_version
  FROM mailbox.classification_log
  ORDER BY inbox_message_id, created_at DESC
)
UPDATE mailbox.inbox_messages m
SET classification = latest.category,
    confidence = latest.confidence::numeric(4,3),
    classified_at = latest.created_at,
    model = latest.model_version
FROM latest
WHERE m.id = latest.inbox_message_id
  AND (m.classification IS DISTINCT FROM latest.category
       OR m.classified_at IS DISTINCT FROM latest.created_at);

WITH latest_draft AS (
  SELECT DISTINCT ON (inbox_message_id) id, inbox_message_id
  FROM mailbox.drafts
  ORDER BY inbox_message_id, created_at DESC
)
UPDATE mailbox.inbox_messages m
SET draft_id = ld.id
FROM latest_draft ld
WHERE m.id = ld.inbox_message_id
  AND m.draft_id IS DISTINCT FROM ld.id;
