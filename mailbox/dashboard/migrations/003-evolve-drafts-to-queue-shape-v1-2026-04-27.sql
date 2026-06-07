-- 003-evolve-drafts-to-queue-shape-v1-2026-04-27.sql
-- Brings mailbox.drafts up to D-17 queue-record shape.

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS draft_source TEXT,
  ADD COLUMN IF NOT EXISTS classification_category TEXT,
  ADD COLUMN IF NOT EXISTS classification_confidence REAL,
  ADD COLUMN IF NOT EXISTS rag_context_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS auto_send_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS from_addr TEXT,
  ADD COLUMN IF NOT EXISTS to_addr TEXT,
  ADD COLUMN IF NOT EXISTS subject TEXT,
  ADD COLUMN IF NOT EXISTS body_text TEXT,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS message_id TEXT,
  ADD COLUMN IF NOT EXISTS thread_id TEXT,
  ADD COLUMN IF NOT EXISTS in_reply_to TEXT,
  ADD COLUMN IF NOT EXISTS "references" TEXT;

ALTER TABLE mailbox.drafts
  DROP CONSTRAINT IF EXISTS drafts_draft_source_check;
ALTER TABLE mailbox.drafts
  ADD CONSTRAINT drafts_draft_source_check
  CHECK (draft_source IS NULL OR draft_source = ANY (ARRAY[
    'local_qwen3','cloud_haiku'
  ]));

ALTER TABLE mailbox.drafts
  DROP CONSTRAINT IF EXISTS drafts_classification_category_check;
ALTER TABLE mailbox.drafts
  ADD CONSTRAINT drafts_classification_category_check
  CHECK (classification_category IS NULL OR classification_category = ANY (ARRAY[
    'inquiry','reorder','scheduling','follow_up',
    'internal','spam_marketing','escalate','unknown'
  ]));

CREATE INDEX IF NOT EXISTS drafts_received_at_idx
  ON mailbox.drafts(received_at DESC);
CREATE INDEX IF NOT EXISTS drafts_category_idx
  ON mailbox.drafts(classification_category);
CREATE INDEX IF NOT EXISTS drafts_rag_refs_gin
  ON mailbox.drafts USING gin(rag_context_refs);

UPDATE mailbox.drafts d
   SET from_addr   = COALESCE(d.from_addr,   m.from_addr),
       to_addr     = COALESCE(d.to_addr,     m.to_addr),
       subject     = COALESCE(d.subject,     m.subject),
       body_text   = COALESCE(d.body_text,   m.body),
       received_at = COALESCE(d.received_at, m.received_at),
       message_id  = COALESCE(d.message_id,  m.message_id),
       thread_id   = COALESCE(d.thread_id,   m.thread_id),
       classification_category   = COALESCE(d.classification_category,
         CASE
           WHEN m.classification IN (
             'inquiry','reorder','scheduling','follow_up',
             'internal','spam_marketing','escalate','unknown'
           ) THEN m.classification
           ELSE 'unknown'
         END),
       classification_confidence = COALESCE(d.classification_confidence,
                                            m.confidence::real)
  FROM mailbox.inbox_messages m
 WHERE d.inbox_message_id = m.id
   AND (d.from_addr IS NULL
        OR d.received_at IS NULL
        OR d.classification_category IS NULL);
