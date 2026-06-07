-- 014-create-kb-documents-and-refs-v1-2026-05-02.sql
--
-- STAQPRO-148: Knowledge Base upload UI. Adds the operator-uploaded SOP /
-- price sheet / policy corpus alongside the existing email-history corpus
-- so the LLM can ground draft replies in authoritative content (FR-32).
--
-- Three changes:
--   1. CREATE TABLE mailbox.kb_documents — doc-level metadata for uploaded
--      files. Original bytes live on the appliance filesystem at
--      /var/lib/mailbox/kb/<sha256>.<ext> (Docker named volume); chunk
--      embeddings live in the new Qdrant `kb_documents` collection. This
--      table is the join key.
--   2. ADD COLUMN drafts.kb_context_refs JSONB DEFAULT '[]'::jsonb +
--      ADD COLUMN sent_history.kb_context_refs JSONB DEFAULT '[]'::jsonb.
--      Parallel to rag_context_refs (STAQPRO-191). Stores the Qdrant point
--      UUIDs retrieved from the kb_documents collection at draft-assembly
--      time. Empty array means retrieval was gated, upstream unavailable,
--      or no relevant doc — disambiguated by the existing
--      rag_retrieval_reason column extending its enum on the app side
--      (no schema change needed for the reason column).
--   3. REPLACE archive_draft_to_sent_history trigger function (last touched
--      by migration 013) so the sent_history archive ALSO copies
--      kb_context_refs alongside rag_context_refs. Same idempotency guard,
--      same draft_original COALESCE behavior — additive change only.
--
-- kb_documents.status enum (TEXT + CHECK constraint, not Postgres ENUM —
-- mirrors the drafts.status pattern from migration 003 for consistency
-- with the lib/types.ts SoT + schema-invariants test):
--   - 'processing' — row inserted by upload route; embedding job queued
--   - 'ready'      — all chunks embedded + upserted to Qdrant
--   - 'failed'     — embedding pipeline errored; error_message populated
--
-- processing_started_at lets the kb-reconciler (lib/rag/kb-reconciler.ts)
-- find rows that got stuck in 'processing' across a dashboard restart.
-- Reconciler runs once on cold-start, flips rows older than 5 min to
-- 'failed' with error_message='interrupted, please retry from UI'. The
-- original sha256-keyed file on disk makes retry trivial — no re-upload
-- needed.
--
-- sha256 UNIQUE handles dedup-on-content. Re-upload of an identical file
-- (same bytes) returns the existing doc_id with duplicate=true rather than
-- creating a second row (handled in the upload route, not at the DB layer).
--
-- Reversal: DROP TABLE mailbox.kb_documents CASCADE handles the FK
-- relationship (currently there are no FKs INTO kb_documents — drafts.kb_context_refs
-- is JSONB array of Qdrant UUIDs, not a referential link to kb_documents.id).
-- DROP COLUMN kb_context_refs on drafts + sent_history cascades fine.
-- Restore the prior trigger function from migration 013 if needed.

-- ── 1. kb_documents table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mailbox.kb_documents (
  id                    SERIAL PRIMARY KEY,
  title                 TEXT NOT NULL,
  filename              TEXT NOT NULL,
  mime_type             TEXT NOT NULL,
  size_bytes            BIGINT NOT NULL,
  sha256                TEXT NOT NULL,
  chunk_count           INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'processing',
  error_message         TEXT,
  uploaded_by           TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at              TIMESTAMPTZ,
  CONSTRAINT kb_documents_sha256_unique UNIQUE (sha256),
  CONSTRAINT kb_documents_status_check CHECK (status = ANY (ARRAY[
    'processing',
    'ready',
    'failed'
  ])),
  CONSTRAINT kb_documents_size_positive CHECK (size_bytes > 0),
  CONSTRAINT kb_documents_chunk_count_nonneg CHECK (chunk_count >= 0)
);

CREATE INDEX IF NOT EXISTS kb_documents_status_idx
  ON mailbox.kb_documents (status);

CREATE INDEX IF NOT EXISTS kb_documents_uploaded_at_idx
  ON mailbox.kb_documents (uploaded_at DESC);

-- Reconciler hot path: WHERE status='processing' AND processing_started_at < NOW() - INTERVAL '5 min'
CREATE INDEX IF NOT EXISTS kb_documents_processing_started_idx
  ON mailbox.kb_documents (processing_started_at)
  WHERE status = 'processing';

-- ── 2. kb_context_refs columns on drafts + sent_history ───────────────────

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS kb_context_refs JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE mailbox.sent_history
  ADD COLUMN IF NOT EXISTS kb_context_refs JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ── 3. Replace archive trigger function to carry kb_context_refs ──────────
--
-- Same INSERT shape as migration 013 plus one new column (kb_context_refs).
-- All prior behavior preserved: idempotency guard, draft_original COALESCE
-- (STAQPRO-121), rag_context_refs + rag_retrieval_reason carry-over
-- (STAQPRO-191).
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
            rag_retrieval_reason,
            kb_context_refs
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
            -- STAQPRO-191 (preserved from migration 013): carry the email
            -- retrieval audit chain.
            COALESCE(NEW.rag_context_refs, '[]'::jsonb),
            COALESCE(NEW.rag_retrieval_reason, 'none'),
            -- STAQPRO-148 (this migration): carry the KB retrieval audit
            -- chain. Parallel surface to rag_context_refs for the eval
            -- delta. Empty array means no KB doc was retrieved (gated, no
            -- hits, or upstream unavailable).
            COALESCE(NEW.kb_context_refs, '[]'::jsonb)
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
