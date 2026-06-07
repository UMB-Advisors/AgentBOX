-- Migration 030 — MBOX-131: structured action items per draft.
-- WHAT: New jsonb column mailbox.drafts.action_items (default '[]'::jsonb),
--       mirrored onto mailbox.sent_history.action_items, and the
--       archive_draft_to_sent_history() trigger extended to carry it at
--       archival time. Each element is an ActionItem object
--       ({ text, type, due_at, source, confidence }) extracted from the
--       inbound email + draft reply post-draft-finalize.
-- WHY:  MBOX-131 (parent epic MBOX-122). Surfaces the concrete asks /
--       commitments / deadlines / meetings in a thread so the operator can
--       review them inline in the draft-detail view before approving. Stored
--       on drafts (NOT a separate table) — the array is small, draft-scoped,
--       and always read with the draft; a join table would add a query per
--       draft for no benefit. Mirrored onto sent_history so the post-send
--       audit chain (state_transitions -> sent_history) carries the action
--       items alongside rag_context_refs / kb_context_refs / exemplar_refs.
-- REVERSAL: ALTER TABLE mailbox.drafts DROP COLUMN action_items; same on
--           mailbox.sent_history. Re-apply migration 020's trigger body to
--           drop action_items from the INSERT (or just leave it — DROP COLUMN
--           CASCADE invalidates the trigger reference, so re-run the prior
--           function definition). No data loss beyond the action_items jsonb.

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS action_items JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE mailbox.sent_history
  ADD COLUMN IF NOT EXISTS action_items JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Extend the migration-020 archival trigger to also carry action_items.
-- Everything else is identical to the prior definition.
CREATE OR REPLACE FUNCTION mailbox.archive_draft_to_sent_history()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent' THEN
        IF EXISTS (SELECT 1 FROM mailbox.sent_history WHERE draft_id = NEW.id) THEN
            RETURN NEW;
        END IF;
        INSERT INTO mailbox.sent_history (
            draft_id, inbox_message_id, from_addr, to_addr, subject, body_text,
            thread_id, draft_original, draft_sent, draft_source,
            classification_category, classification_confidence, sent_at,
            rag_context_refs, rag_retrieval_reason, kb_context_refs, exemplar_refs,
            action_items
        ) VALUES (
            NEW.id, NEW.inbox_message_id,
            COALESCE(NEW.from_addr, ''), COALESCE(NEW.to_addr, ''),
            NEW.subject, NEW.body_text, NEW.thread_id,
            COALESCE(NEW.original_draft_body, NEW.draft_body),
            NEW.draft_body,
            COALESCE(NEW.draft_source, 'local'),
            COALESCE(NEW.classification_category, 'unknown'),
            COALESCE(NEW.classification_confidence, 0.0),
            COALESCE(NEW.sent_at, NOW()),
            COALESCE(NEW.rag_context_refs, '[]'::jsonb),
            COALESCE(NEW.rag_retrieval_reason, 'none'),
            COALESCE(NEW.kb_context_refs, '[]'::jsonb),
            COALESCE(NEW.exemplar_refs, '[]'::jsonb),
            COALESCE(NEW.action_items, '[]'::jsonb)
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
