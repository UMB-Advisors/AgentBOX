-- Migration 020 — STAQPRO-234 (KB Phase 1): few-shot exemplars from sent_history.
-- WHAT: New jsonb column mailbox.drafts.exemplar_refs (default '[]'::jsonb).
--       Holds an array of mailbox.sent_history.message_id strings (NOT Qdrant
--       point UUIDs — these are postgres-internal pointers, not vector refs)
--       that were injected into the drafting prompt as past-reply exemplars.
--       Mirrored onto mailbox.sent_history.exemplar_refs at archival time so
--       the audit chain (state_transitions → sent_history) carries the
--       exemplar provenance alongside rag_context_refs and kb_context_refs.
-- WHY:  Phase 1 of the KB-population streamlining plan
--       (~/.claude/plans/what-do-you-neo-neo-architect-typed-fountain.md).
--       The drafting prompt now has a third augmentation slot — past replies
--       the operator wrote for this category — separate from RAG retrieval
--       (vector-similar emails) and KB retrieval (operator-uploaded SOPs).
--
--       Sibling column rather than reusing rag_context_refs: STAQPRO-191/192's
--       eval surface depends on rag_context_refs being a UUID array of Qdrant
--       points, and the archival trigger from migration 013/014 already
--       carries that semantically. Mixing in postgres-row references would
--       force a discriminator field and break the existing replay path
--       (`curl -X POST $QDRANT_URL/collections/email_messages/points -d
--       '{"ids":[...]}'`). Adding a sibling column keeps the existing audit
--       chain pure and gives Phase-1 evals (does the cloud-rate metric trend
--       down 7-day rolling?) their own clean signal column.
-- REVERSAL: ALTER TABLE mailbox.drafts DROP COLUMN exemplar_refs; same on
--           mailbox.sent_history. Trigger reverts to migration 014 shape.
--           No data loss beyond the exemplar_refs jsonb itself.

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS exemplar_refs JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE mailbox.sent_history
  ADD COLUMN IF NOT EXISTS exemplar_refs JSONB NOT NULL DEFAULT '[]'::jsonb;

-- v020 trigger function: extends 014 to also carry exemplar_refs.
-- Same idempotency guard (skip if sent_history row already exists for draft_id).
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
            rag_context_refs, rag_retrieval_reason, kb_context_refs, exemplar_refs
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
            COALESCE(NEW.exemplar_refs, '[]'::jsonb)
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
