-- 012-add-original-draft-body-for-edit-deltas-v1-2026-05-02.sql
--
-- STAQPRO-121 capture-side: snapshot the LLM's original draft_body before
-- the operator's first edit overwrites it. Without this, draft_original in
-- sent_history (migration 010) silently equals draft_sent — there's no edit
-- delta to learn from. Migration 010's trigger header explicitly flagged
-- this as a TODO ("once an edit history table exists, swap in that column").
--
-- Two changes:
--   1. ADD COLUMN drafts.original_draft_body TEXT (nullable). NULL = no edit
--      ever happened on this draft. The edit route populates it on first
--      edit and never overwrites it on subsequent edits, preserving the
--      true LLM-original delta.
--   2. REPLACE the archive_draft_to_sent_history trigger function so
--      draft_original = COALESCE(NEW.original_draft_body, NEW.draft_body).
--      Unedited drafts: original == sent (no signal). Edited drafts:
--      original = the LLM's first attempt; sent = the operator's
--      hand-tuned final.
--
-- Capture-only scope. Synthesis (delta stats, prompt feedback, persona
-- enrichment) is the follow-up ticket. The `source` column from migration
-- 011 keeps its DEFAULT 'live' for live-archived rows — this trigger
-- doesn't set it explicitly, preserving migration 010's INSERT shape.
--
-- Reversal: DROP COLUMN original_draft_body cascades fine (no FKs target
-- it). Restore the prior trigger function from migration 010 if needed.

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS original_draft_body TEXT;

-- Replace migration 010's trigger function. Same INSERT shape (no schema
-- change), same idempotency guard, only difference: draft_original now
-- coalesces to original_draft_body when the operator edited.
CREATE OR REPLACE FUNCTION mailbox.archive_draft_to_sent_history()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent' THEN
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
            -- STAQPRO-121: prefer the snapshotted LLM original when the
            -- operator edited; fall back to the current body when no edit
            -- happened (in which case original == sent and there's no delta).
            COALESCE(NEW.original_draft_body, NEW.draft_body),
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
