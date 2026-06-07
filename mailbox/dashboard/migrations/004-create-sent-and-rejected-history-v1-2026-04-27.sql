-- 004-create-sent-and-rejected-history-v1-2026-04-27.sql
-- Archival targets (D-19): on approve -> sent_history; on reject -> rejected_history.

CREATE TABLE IF NOT EXISTS mailbox.sent_history (
  id                        BIGSERIAL PRIMARY KEY,
  draft_id                  INTEGER NOT NULL,
  inbox_message_id          INTEGER NOT NULL,
  from_addr                 TEXT    NOT NULL,
  to_addr                   TEXT    NOT NULL,
  subject                   TEXT,
  body_text                 TEXT,
  thread_id                 TEXT,
  draft_original            TEXT,
  draft_sent                TEXT    NOT NULL,
  draft_source              TEXT    NOT NULL,
  classification_category   TEXT    NOT NULL,
  classification_confidence REAL    NOT NULL,
  rag_context_refs          JSONB   NOT NULL DEFAULT '[]'::jsonb,
  sent_at                   TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sent_history_draft_source_check
    CHECK (draft_source = ANY (ARRAY['local_qwen3','cloud_haiku'])),
  CONSTRAINT sent_history_category_check
    CHECK (classification_category = ANY (ARRAY[
      'inquiry','reorder','scheduling','follow_up',
      'internal','spam_marketing','escalate','unknown'
    ]))
);

CREATE INDEX IF NOT EXISTS sent_history_sent_at_idx
  ON mailbox.sent_history(sent_at DESC);
CREATE INDEX IF NOT EXISTS sent_history_category_idx
  ON mailbox.sent_history(classification_category);

CREATE TABLE IF NOT EXISTS mailbox.rejected_history (
  id                        BIGSERIAL PRIMARY KEY,
  draft_id                  INTEGER NOT NULL,
  inbox_message_id          INTEGER NOT NULL,
  from_addr                 TEXT    NOT NULL,
  subject                   TEXT,
  classification_category   TEXT    NOT NULL,
  classification_confidence REAL    NOT NULL,
  draft_original            TEXT,
  rejected_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rejected_history_category_check
    CHECK (classification_category = ANY (ARRAY[
      'inquiry','reorder','scheduling','follow_up',
      'internal','spam_marketing','escalate','unknown'
    ]))
);

CREATE INDEX IF NOT EXISTS rejected_history_rejected_at_idx
  ON mailbox.rejected_history(rejected_at DESC);
