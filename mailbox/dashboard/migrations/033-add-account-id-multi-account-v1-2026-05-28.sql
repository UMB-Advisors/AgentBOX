-- Migration 033 — MBOX-348 (MBOX-162 V1 / FR-4 / DR-43): multi-account.
-- WHAT: Introduces `account_id` as a first-class dimension across every
--       account-scoped table, backed by a new mailbox.accounts table (one row
--       per connected Gmail identity on the appliance). Promotes the S2 dry-run
--       candidate (docs/s2-account-id-migration-candidate-v0_1-2026-05-28.sql,
--       which covered only the 4 core pipeline tables) to the FULL set Linus
--       flagged on PR #166: + kb_documents, vip_senders, auto_send_rules,
--       auto_send_audit, chat_conversations, chat_messages, oauth_tokens,
--       draft_feedback, rejected_history. state_transitions is intentionally
--       NOT given a column — it inherits account scope via its drafts FK.
-- WHY:  FR-4 (multiple inboxes per appliance, up to 3 in v1) — collapse N
--       single-account appliances into one box serving N personas. This is the
--       schema substrate; the ingestion fan-out (per-account Gmail OAuth, polled
--       serially per DR-45) and the V2/V3 isolation/queue vectors build on top.
-- BACKFILL DETERMINISM (the S2 question, PASS): M1 is single-account today, so
--       every historical row belongs to the one connected mailbox. All rows
--       backfill to a single seeded `accounts` row → fully deterministic, no
--       manual surgery, DR-43 kill criterion NOT triggered. The default email is
--       sourced from mailbox.onboarding.email_address (the connected mailbox),
--       with a 'primary@appliance.local' sentinel fallback the operator renames
--       post-migration (see runbook docs/runbook-multi-account-ingestion-...md).
-- NON-BREAKING BY DESIGN: every account_id column is given a DEFAULT pointing at
--       the seeded default account. Existing writers that don't yet pass
--       account_id (today's single-account n8n Postgres nodes, un-updated
--       dashboard routes) keep working untouched — their rows land in the
--       default account. The ingestion fan-out and the updated
--       /api/internal/inbox-messages route OVERRIDE the default with the explicit
--       per-account id. This is what lets V1 ship without touching every INSERT
--       path at once.
-- DENORMALIZATION NOTE (for Linus/Dustin review): auto_send_audit, chat_messages,
--       and draft_feedback already inherit an account via their parent FK
--       (drafts / chat_conversations). The ticket asks to denormalize account_id
--       onto them anyway (query convenience); we comply, but the parent FK
--       remains the true scope. App code that inserts into these must keep
--       account_id consistent with the parent once V2/V3 makes them multi-account
--       (until then the column DEFAULT keeps them correct for the single operator).
--       kb_documents keeps its GLOBAL UNIQUE(sha256) for V1 (per-account KB
--       isolation — a reshape to UNIQUE(account_id, sha256) — is a V2 concern).
-- KEY RESHAPES: (1) inbox_messages UNIQUE(message_id) → UNIQUE(account_id,
--       message_id); (2) sent_history partial UNIQUE(message_id) → partial
--       UNIQUE(account_id, message_id) — the same Gmail message can legitimately
--       land in two connected inboxes (addressed to founder@ and consulting@);
--       the global uniques would wrongly reject it. (3) oauth_tokens PRIMARY KEY
--       (provider) → (provider, account_id) so each account stores its own
--       Google refresh token.
-- OUT OF BAND (not SQL): existing Qdrant email_messages points need account_id
--       added to their payload (deterministic → default account). Handled by the
--       one-shot scripts/retag-qdrant-account-id.ts, run as part of the same
--       deploy (see runbook).
-- ROLLBACK: drop the per-table FKs + account_id columns; restore
--       inbox_messages UNIQUE(message_id) and the sent_history partial unique on
--       (message_id); restore oauth_tokens PRIMARY KEY (provider); DROP TABLE
--       mailbox.accounts. Backfill is non-destructive (original rows intact); the
--       Qdrant re-tag is forward-compatible (an extra payload field old readers
--       ignore), so no Qdrant rollback is required.

-- 1. Accounts table — one row per connected Gmail identity on the appliance.
CREATE TABLE mailbox.accounts (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_address text NOT NULL UNIQUE,
  display_label text,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- At most one default account (the backfill target). Partial unique index so
-- the "WHERE is_default" lookups are unambiguous.
CREATE UNIQUE INDEX accounts_one_default ON mailbox.accounts (is_default) WHERE is_default;

-- 2. Seed the single existing account + add/backfill/default/NOT NULL/FK the
--    account_id dimension across every account-scoped table in one uniform pass.
DO $$
DECLARE
  default_acct  integer;
  default_email text;
  t             text;
  scoped_tables text[] := ARRAY[
    -- core pipeline (S2 PASS set)
    'inbox_messages', 'drafts', 'classification_log', 'sent_history',
    -- promote-time extension (Linus, PR #166)
    'kb_documents', 'vip_senders', 'auto_send_rules', 'auto_send_audit',
    'chat_conversations', 'chat_messages', 'oauth_tokens', 'draft_feedback',
    'rejected_history'
  ];
BEGIN
  -- Default account email = the one connected mailbox, if onboarding recorded it.
  SELECT email_address INTO default_email
    FROM mailbox.onboarding
    WHERE email_address IS NOT NULL
    ORDER BY id
    LIMIT 1;
  IF default_email IS NULL THEN
    default_email := 'primary@appliance.local';
  END IF;

  INSERT INTO mailbox.accounts (email_address, display_label, is_default)
  VALUES (default_email, 'Primary (backfilled)', true)
  RETURNING id INTO default_acct;

  FOREACH t IN ARRAY scoped_tables LOOP
    EXECUTE format('ALTER TABLE mailbox.%I ADD COLUMN account_id integer', t);
    EXECUTE format('UPDATE mailbox.%I SET account_id = %s WHERE account_id IS NULL', t, default_acct);
    EXECUTE format('ALTER TABLE mailbox.%I ALTER COLUMN account_id SET DEFAULT %s', t, default_acct);
    EXECUTE format('ALTER TABLE mailbox.%I ALTER COLUMN account_id SET NOT NULL', t);
    EXECUTE format(
      'ALTER TABLE mailbox.%I ADD CONSTRAINT %I FOREIGN KEY (account_id) REFERENCES mailbox.accounts(id)',
      t, t || '_account_fk'
    );
  END LOOP;
END $$;

-- 3. Reshape the inbox dedup key: global UNIQUE(message_id) → per-account.
ALTER TABLE mailbox.inbox_messages DROP CONSTRAINT inbox_messages_message_id_key;
ALTER TABLE mailbox.inbox_messages
  ADD CONSTRAINT inbox_messages_account_message_uq UNIQUE (account_id, message_id);

-- 4. Reshape the sent_history dedup index (partial: only backfilled/live rows
--    that carry a Gmail message_id) the same way.
DROP INDEX mailbox.sent_history_message_id_unique;
CREATE UNIQUE INDEX sent_history_account_message_unique
  ON mailbox.sent_history (account_id, message_id) WHERE message_id IS NOT NULL;

-- 5. oauth_tokens: one Google refresh token PER ACCOUNT. The PK was (provider);
--    make it (provider, account_id). (The account_id column + FK were already
--    added by the loop above.)
ALTER TABLE mailbox.oauth_tokens DROP CONSTRAINT oauth_tokens_pkey;
ALTER TABLE mailbox.oauth_tokens ADD CONSTRAINT oauth_tokens_pkey PRIMARY KEY (provider, account_id);

-- 6. Supporting indexes for per-account filtering on the high-volume tables.
--    (inbox_messages + sent_history are already covered by their composite
--    unique constraints whose leading column is account_id.)
CREATE INDEX drafts_account_id_idx ON mailbox.drafts (account_id);
CREATE INDEX classification_log_account_id_idx ON mailbox.classification_log (account_id);

-- 7. Carry account_id through the sent_history archival trigger so a sent draft
--    archives under ITS account, not the column DEFAULT. Without this, a draft
--    belonging to a second account would archive with the default account_id.
--    Identical to migration 030's function except for the added account_id
--    column (= NEW.account_id).
CREATE OR REPLACE FUNCTION mailbox.archive_draft_to_sent_history()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent' THEN
        IF EXISTS (SELECT 1 FROM mailbox.sent_history WHERE draft_id = NEW.id) THEN
            RETURN NEW;
        END IF;
        INSERT INTO mailbox.sent_history (
            account_id,
            draft_id, inbox_message_id, from_addr, to_addr, subject, body_text,
            thread_id, draft_original, draft_sent, draft_source,
            classification_category, classification_confidence, sent_at,
            rag_context_refs, rag_retrieval_reason, kb_context_refs, exemplar_refs,
            action_items
        ) VALUES (
            NEW.account_id,
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
