-- 010-fix-sent-history-and-archive-trigger-v1-2026-05-01.sql
--
-- STAQPRO-189: fix mailbox.sent_history archival path. Two problems on the
-- live appliance (1 sent draft, 0 sent_history rows):
--   1. The CHECK constraint pinned draft_source to legacy ('local_qwen3',
--      'cloud_haiku'); the live drafting path writes 'local' / 'cloud' per
--      migration 008 + project CLAUDE.md. Any insert from current code would
--      be rejected. (Same pattern 008 applied to mailbox.drafts.)
--   2. There was no insert site at all — the n8n MailBOX-Send sub-workflow
--      only updates drafts.status to 'sent'/'failed'; it does not archive to
--      sent_history. Audit confirmed via reading n8n/workflows/MailBOX-Send.json.
--
-- Fix (Postgres-side, mirrors the 009 state_transitions trigger pattern):
--   - Drop + replace sent_history_draft_source_check, accepting current and
--     legacy values for forward-compat with historical reads.
--   - Add an AFTER UPDATE trigger on mailbox.drafts that fires when status
--     transitions to 'sent' and copies the row into sent_history. Idempotent
--     guard: skip if a sent_history row with the same draft_id already exists
--     (defensive — should not happen given the trigger condition, but cheap).
--   - Backfill: copy the one historical sent draft into sent_history so the
--     table isn't empty after wire-up.
--
-- Why a trigger and not an n8n node: trigger is atomic with the status flip,
-- can't be skipped if someone forgets to wire a node in MailBOX-Send, and
-- doesn't require a workflow JSON edit + n8n container restart per
-- conventions ("n8n update:workflow --active is a no-op until restart").
-- Same reasoning that justified the 009 state_transitions trigger.
--
-- Reversal: DROP TRIGGER drafts_archive_to_sent_history; DROP FUNCTION
-- mailbox.archive_draft_to_sent_history(); restore the old check constraint.
-- The backfill row can be removed by `DELETE FROM mailbox.sent_history WHERE
-- draft_id IN (...)` if needed.

ALTER TABLE mailbox.sent_history
  DROP CONSTRAINT IF EXISTS sent_history_draft_source_check;

ALTER TABLE mailbox.sent_history
  ADD CONSTRAINT sent_history_draft_source_check
  CHECK (draft_source = ANY (ARRAY[
    'local',
    'cloud',
    -- legacy values, preserved for any historical rows
    'local_qwen3',
    'cloud_haiku'
  ]));

-- Trigger function: archive to sent_history when a draft transitions to
-- status='sent'. Reads from the NEW row + the inbox_messages join because
-- some columns (subject, body_text, draft_subject) may have been edited
-- between draft creation and approval. Sources of truth, in order:
--   - draft_original  ← the pre-edit draft body. STAQPRO-189 phase 1 uses
--                       NEW.draft_body as a fallback because we don't carry a
--                       separate "pre-edit" snapshot column today; once an
--                       edit history table exists, swap in that column.
--   - draft_sent      ← NEW.draft_body (post-edit, the body actually sent)
--   - body_text       ← NEW.body_text (the inbound message body that prompted this draft)
CREATE OR REPLACE FUNCTION mailbox.archive_draft_to_sent_history()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent' THEN
        -- Idempotency guard. If a row already exists for this draft (re-fire,
        -- manual UPDATE), skip rather than violate uniqueness or duplicate.
        IF EXISTS (SELECT 1 FROM mailbox.sent_history WHERE draft_id = NEW.id) THEN
            RETURN NEW;
        END IF;

        INSERT INTO mailbox.sent_history (
            draft_id,
            inbox_message_id,
            from_addr,
            to_addr,
            subject,
            body_text,
            thread_id,
            draft_original,
            draft_sent,
            draft_source,
            classification_category,
            classification_confidence,
            sent_at
        ) VALUES (
            NEW.id,
            NEW.inbox_message_id,
            COALESCE(NEW.from_addr, ''),
            COALESCE(NEW.to_addr, ''),
            NEW.subject,
            NEW.body_text,
            NEW.thread_id,
            NEW.draft_body,  -- pre-edit snapshot not separately tracked yet; phase 2
            NEW.draft_body,
            COALESCE(NEW.draft_source, 'local'),
            COALESCE(NEW.classification_category, 'unknown'),
            COALESCE(NEW.classification_confidence, 0.0),
            COALESCE(NEW.sent_at, NOW())
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drafts_archive_to_sent_history
    AFTER UPDATE OF status ON mailbox.drafts
    FOR EACH ROW
    EXECUTE FUNCTION mailbox.archive_draft_to_sent_history();

-- One-time backfill: any draft already at status='sent' before this trigger
-- existed should be archived now. The trigger function's idempotency guard
-- keeps this safe to re-run if needed.
INSERT INTO mailbox.sent_history (
    draft_id, inbox_message_id, from_addr, to_addr, subject, body_text,
    thread_id, draft_original, draft_sent, draft_source,
    classification_category, classification_confidence, sent_at
)
SELECT
    d.id,
    d.inbox_message_id,
    COALESCE(d.from_addr, ''),
    COALESCE(d.to_addr, ''),
    d.subject,
    d.body_text,
    d.thread_id,
    d.draft_body,
    d.draft_body,
    COALESCE(d.draft_source, 'local'),
    COALESCE(d.classification_category, 'unknown'),
    COALESCE(d.classification_confidence, 0.0),
    COALESCE(d.sent_at, d.updated_at, NOW())
FROM mailbox.drafts d
WHERE d.status = 'sent'
  AND NOT EXISTS (
      SELECT 1 FROM mailbox.sent_history sh WHERE sh.draft_id = d.id
  );
