-- S2 dry-run candidate — DR-43 account_id schema migration (MBOX-162)
--
-- STATUS: CANDIDATE / DRY-RUN ARTIFACT — NOT a live migration.
--   Do NOT place this in dashboard/migrations/ (the runner would apply it).
--   DR-43 is gated on this S2 spike (addendum §6); promote to a numbered
--   migration only after S1 + S2 pass and DR-43 moves Candidate → Accepted.
--
-- WHAT: introduces `account_id` as a first-class dimension across the
--   pipeline tables, per DR-43 "new accounts table + FK" (not overloading
--   customer/appliance).
-- SCOPE (Linus, PR #166): this dry-run covers the 4 CORE pipeline tables only
--   (inbox_messages, drafts, classification_log, sent_history). The live schema
--   has grown other account-scoped tables that the PROMOTE-time migration must
--   also cover: kb_documents, vip_senders, auto_send_rules, auto_send_audit,
--   chat_conversations, chat_messages, oauth_tokens, draft_feedback,
--   rejected_history (state_transitions inherits via its drafts FK). S2 PASS is
--   for the core four; full promote scope is a second pass.
-- WHY: multi-account (FR-4) — one appliance serving N Gmail identities.
-- BACKFILL DETERMINISM (the S2 question): M1 is single-account today, so
--   every historical row belongs to the one existing connected mailbox.
--   Backfill assigns all rows to a single seeded `accounts` row → fully
--   deterministic, no manual surgery. DR-43 kill criterion NOT triggered.
-- KEY RESHAPE: inbox_messages dedup key moves from UNIQUE(message_id) to
--   UNIQUE(account_id, message_id) — the same Gmail message can legitimately
--   land in two connected inboxes (e.g. addressed to founder@ and consulting@).
--   The /api/internal/inbox-messages xmax dedup must include account_id.
-- REVERSAL: drop FKs, drop account_id columns, restore UNIQUE(message_id),
--   drop accounts table. (Backfill is non-destructive; original rows intact.)

BEGIN;

-- 1. Accounts table — one row per connected Gmail identity on the appliance.
CREATE TABLE mailbox.accounts (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_address text NOT NULL UNIQUE,
  display_label text,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- At most one default account (the backfill target). Partial unique index so
-- the DO-block `SELECT id INTO ... WHERE is_default` is unambiguous.
CREATE UNIQUE INDEX accounts_one_default ON mailbox.accounts (is_default) WHERE is_default;

-- 2. Seed the single existing account (backfill target). On M1 this is the
--    one connected mailbox; email is parameterized at promote-time.
INSERT INTO mailbox.accounts (email_address, display_label, is_default)
VALUES (:'default_account_email', 'Primary (backfilled)', true);

-- 3. Add nullable account_id to each pipeline table, backfill to the default
--    account, then enforce NOT NULL + FK. Nullable-first keeps the backfill
--    a single UPDATE with zero ambiguity (single account → one target).
DO $$
DECLARE
  default_acct integer;
BEGIN
  SELECT id INTO default_acct FROM mailbox.accounts WHERE is_default;

  ALTER TABLE mailbox.inbox_messages     ADD COLUMN account_id integer;
  ALTER TABLE mailbox.drafts             ADD COLUMN account_id integer;
  ALTER TABLE mailbox.classification_log ADD COLUMN account_id integer;
  ALTER TABLE mailbox.sent_history       ADD COLUMN account_id integer;

  UPDATE mailbox.inbox_messages     SET account_id = default_acct WHERE account_id IS NULL;
  UPDATE mailbox.drafts             SET account_id = default_acct WHERE account_id IS NULL;
  UPDATE mailbox.classification_log SET account_id = default_acct WHERE account_id IS NULL;
  UPDATE mailbox.sent_history       SET account_id = default_acct WHERE account_id IS NULL;
END $$;

ALTER TABLE mailbox.inbox_messages
  ALTER COLUMN account_id SET NOT NULL,
  ADD CONSTRAINT inbox_messages_account_fk FOREIGN KEY (account_id) REFERENCES mailbox.accounts(id);
ALTER TABLE mailbox.drafts
  ALTER COLUMN account_id SET NOT NULL,
  ADD CONSTRAINT drafts_account_fk FOREIGN KEY (account_id) REFERENCES mailbox.accounts(id);
ALTER TABLE mailbox.classification_log
  ALTER COLUMN account_id SET NOT NULL,
  ADD CONSTRAINT classification_log_account_fk FOREIGN KEY (account_id) REFERENCES mailbox.accounts(id);
ALTER TABLE mailbox.sent_history
  ALTER COLUMN account_id SET NOT NULL,
  ADD CONSTRAINT sent_history_account_fk FOREIGN KEY (account_id) REFERENCES mailbox.accounts(id);

-- 4. Reshape the inbox dedup key: global UNIQUE(message_id) → per-account.
ALTER TABLE mailbox.inbox_messages DROP CONSTRAINT inbox_messages_message_id_key;
ALTER TABLE mailbox.inbox_messages
  ADD CONSTRAINT inbox_messages_account_message_uq UNIQUE (account_id, message_id);

-- NOTE (Qdrant, out of band): existing email_messages points need account_id
--   added to their payload (deterministic → default account). Handled by a
--   one-shot re-tag, not SQL. Tracked alongside this migration.

COMMIT;
