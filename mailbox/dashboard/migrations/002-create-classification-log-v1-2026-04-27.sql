-- 002-create-classification-log-v1-2026-04-27.sql
-- Per-classification audit log (D-21). Spam/marketing drops also land here.

CREATE TABLE IF NOT EXISTS mailbox.classification_log (
  id              BIGSERIAL PRIMARY KEY,
  inbox_message_id INTEGER NOT NULL
    REFERENCES mailbox.inbox_messages(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  confidence      REAL NOT NULL,
  model_version   TEXT NOT NULL,
  latency_ms      INTEGER,
  raw_output      TEXT,
  json_parse_ok   BOOLEAN NOT NULL,
  think_stripped  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT classification_log_category_check CHECK (category = ANY (ARRAY[
    'inquiry','reorder','scheduling','follow_up',
    'internal','spam_marketing','escalate','unknown'
  ]))
);

CREATE INDEX IF NOT EXISTS classification_log_message_idx
  ON mailbox.classification_log(inbox_message_id);
CREATE INDEX IF NOT EXISTS classification_log_category_idx
  ON mailbox.classification_log(category);

INSERT INTO mailbox.classification_log
  (inbox_message_id, category, confidence, model_version,
   json_parse_ok, think_stripped, created_at)
SELECT
  m.id,
  CASE
    WHEN m.classification IN (
      'inquiry','reorder','scheduling','follow_up',
      'internal','spam_marketing','escalate','unknown'
    ) THEN m.classification
    ELSE 'unknown'
  END                                                 AS category,
  COALESCE(m.confidence, 0)::real                     AS confidence,
  COALESCE(m.model, 'backfill-unknown')               AS model_version,
  TRUE                                                AS json_parse_ok,
  FALSE                                               AS think_stripped,
  COALESCE(m.classified_at, m.created_at, NOW())      AS created_at
FROM mailbox.inbox_messages m
WHERE m.classification IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM mailbox.classification_log cl
    WHERE cl.inbox_message_id = m.id
  );
