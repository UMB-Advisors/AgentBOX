-- Migration 023 — STAQPRO-331 (#1): structured reject-feedback table.
-- WHAT: New mailbox.draft_feedback table. One row per reject action, keyed
--       by draft_id, carrying a closed-enum reason_code + optional free_text.
--       Replaces the prior "stuff free-text into drafts.error_message" path,
--       which conflicted with the send-side semantic of error_message (set
--       by MailBOX-Send on Gmail Reply failure) per CLAUDE.md state machine.
-- WHY:  Unblocks the learning loop. reason_code is a structured signal that
--       downstream consumers can aggregate:
--         wrong_tone           → persona resolver (tone/sign-off/formality)
--         factually_inaccurate → RAG retrieval gap or hallucination
--         missing_context      → RAG recall miss
--         should_reply_myself  → reclassify category to 'escalate'
--         dont_reply           → classifier miss (should be 'spam_marketing')
--         other                → free-text only (requires free_text)
-- ROLLBACK: DROP TABLE mailbox.draft_feedback; ALTER TABLE mailbox.drafts
--          re-allow text writes into error_message via reject route (revert
--          STAQPRO-331 #1 commit). Audit chain via state_transitions is
--          unaffected — that table is the source of truth for status flips
--          regardless of feedback presence.

CREATE TABLE IF NOT EXISTS mailbox.draft_feedback (
  id           SERIAL PRIMARY KEY,
  draft_id     INTEGER NOT NULL REFERENCES mailbox.drafts(id) ON DELETE CASCADE,
  reason_code  TEXT NOT NULL,
  free_text    TEXT,
  operator_id  TEXT,
  rejected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Closed enum. Keep in lockstep with REJECT_REASON_CODES in
  -- dashboard/lib/types.ts; the schema-invariants test asserts this.
  CONSTRAINT draft_feedback_reason_code_check CHECK (
    reason_code IN (
      'wrong_tone',
      'factually_inaccurate',
      'missing_context',
      'should_reply_myself',
      'dont_reply',
      'other'
    )
  ),

  -- 'other' must include free_text. Other codes may include free_text but
  -- it's optional context, not required.
  CONSTRAINT draft_feedback_other_requires_text CHECK (
    reason_code <> 'other' OR (free_text IS NOT NULL AND length(trim(free_text)) > 0)
  )
);

CREATE INDEX IF NOT EXISTS draft_feedback_draft_id_idx
  ON mailbox.draft_feedback(draft_id);

CREATE INDEX IF NOT EXISTS draft_feedback_reason_code_idx
  ON mailbox.draft_feedback(reason_code);
