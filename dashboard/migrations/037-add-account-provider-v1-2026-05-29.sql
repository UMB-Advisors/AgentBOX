-- Migration 037 — MBOX-356 (MBOX-355 P0 / DR-55, DR-57): mail-transport provider
-- as a first-class dimension on mailbox.accounts.
-- WHAT: add `provider` (gmail|imap|microsoft) + `provider_config` jsonb to
--       mailbox.accounts. `provider` is the discriminator the MailProvider
--       factory (dashboard/lib/mail/providers) keys off; `provider_config` holds
--       per-transport connection params (IMAP host/port/TLS; Graph tenant/scopes;
--       empty for gmail). SoT for the CHECK = MAIL_PROVIDERS in lib/types.ts.
-- WHY:  MBOX-355 multi-provider mail (IMAP/SMTP + Microsoft 365). P0 establishes
--       the dimension so P1 (IMAP, MBOX-357) attaches as a new MailProvider class
--       rather than a fork. NOTE: distinct from oauth_tokens.provider (the Google
--       OAuth grant key — google_calendar|google_tasks|google_drive). Composes
--       with the account_id dimension (migration 033) per NC-35 = "compose":
--       (account_id, provider) is the universal key going forward.
-- NON-BREAKING: provider defaults to 'gmail' so every existing account (M1 is
--       Gmail) backfills deterministically; provider_config defaults to '{}'.
--       No data migration, no live-path behavior change (accounts=1/gmail today).
--       The cooldown reshape + drafts.provider_message_id (rest of DR-57) are
--       deferred to the phase that consumes them (P1) to avoid dead schema.
-- REVERSAL: ALTER TABLE mailbox.accounts DROP COLUMN provider_config;
--           ALTER TABLE mailbox.accounts DROP COLUMN provider;

ALTER TABLE mailbox.accounts
  ADD COLUMN provider text NOT NULL DEFAULT 'gmail'
    CHECK (provider IN ('gmail', 'imap', 'microsoft'));

ALTER TABLE mailbox.accounts
  ADD COLUMN provider_config jsonb NOT NULL DEFAULT '{}'::jsonb;
