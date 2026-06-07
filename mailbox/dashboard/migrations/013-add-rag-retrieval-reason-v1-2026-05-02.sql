-- 013-add-rag-retrieval-reason-v1-2026-05-02.sql
--
-- STAQPRO-191: add rag_retrieval_reason column to drafts + sent_history so
-- empty rag_context_refs can be disambiguated for the eval delta harness.
--
-- Without this column, an empty rag_context_refs array is ambiguous between
-- "no_hits" (sender had no history — RAG couldn't have helped), "embed_unavailable"
-- (Ollama embed call failed — transient infra), "qdrant_unavailable" (vector
-- DB outage — transient infra), and "cloud_gated" (privacy-first opt-out).
-- The STAQPRO-192 phase-2 eval delta cannot tell whether a draft improved
-- because of RAG or because the sender happened to have no history. Linus
-- pre-flight #2: separate column is cleaner than overloading JSONB shape —
-- no compatibility break with PR #18 baseline harness readers.
--
-- Changes:
--   1. ADD COLUMN drafts.rag_retrieval_reason TEXT NOT NULL DEFAULT 'none'.
--      'none' is the pre-191 baseline (no retrieval attempted at all). Live
--      values: 'ok' | 'cloud_gated' | 'embed_unavailable' | 'no_hits' |
--      'qdrant_unavailable'. Enum stays application-side rather than DB
--      CHECK to avoid migration churn when the retrieval module gains new
--      reason codes.
--   2. ADD COLUMN sent_history.rag_retrieval_reason TEXT NOT NULL DEFAULT 'none'.
--   3. REPLACE archive_draft_to_sent_history trigger function (last touched by
--      migration 012) so the carry-forward also copies rag_retrieval_reason
--      and rag_context_refs from drafts → sent_history. Prior behavior of
--      012 (draft_original COALESCE) is preserved unchanged.
--
-- Reversal: DROP COLUMN rag_retrieval_reason on both tables cascades fine
-- (no FKs target it, no indexes). Restore the prior trigger function from
-- migration 012 if needed.

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS rag_retrieval_reason TEXT NOT NULL DEFAULT 'none';

ALTER TABLE mailbox.sent_history
  ADD COLUMN IF NOT EXISTS rag_retrieval_reason TEXT NOT NULL DEFAULT 'none';

-- Replace migration 012's trigger function. Same INSERT shape plus two new
-- columns: rag_context_refs (already exists on both tables since migration
-- 003/004 — was being silently dropped during archival until now) and
-- rag_retrieval_reason (new). draft_original COALESCE behavior from 012
-- preserved unchanged.
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
            sent_at,
            rag_context_refs,
            rag_retrieval_reason
        ) VALUES (
            NEW.id,
            NEW.inbox_message_id,
            COALESCE(NEW.from_addr, ''),
            COALESCE(NEW.to_addr, ''),
            NEW.subject,
            NEW.body_text,
            NEW.thread_id,
            -- STAQPRO-121 (preserved from migration 012): prefer snapshotted
            -- LLM original when the operator edited; fall back to draft_body.
            COALESCE(NEW.original_draft_body, NEW.draft_body),
            NEW.draft_body,
            COALESCE(NEW.draft_source, 'local'),
            COALESCE(NEW.classification_category, 'unknown'),
            COALESCE(NEW.classification_confidence, 0.0),
            COALESCE(NEW.sent_at, NOW()),
            -- STAQPRO-191: carry the retrieval audit chain into sent_history.
            -- The eval delta (STAQPRO-192 phase 2) reads from sent_history,
            -- so without these two it can't see whether RAG actually fired.
            COALESCE(NEW.rag_context_refs, '[]'::jsonb),
            COALESCE(NEW.rag_retrieval_reason, 'none')
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
