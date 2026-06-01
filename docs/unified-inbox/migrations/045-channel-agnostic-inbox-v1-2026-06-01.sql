-- Migration 045 — AgentBOX Unified Inbox Phase 0: channel-agnostic columns.
-- WHAT: Makes the core inbound tables channel-aware so ONE pipeline can carry
--       email AND social/chat (Telegram, Discord, Slack, WhatsApp, Signal, SMS,
--       Teams, Matrix, …) — see HermesBOX/docs/unified-inbox-prd (Phase 0).
--       Adds `channel` to mailbox.accounts, mailbox.inbox_messages, mailbox.drafts;
--       adds inbox_messages.external_id (provider-agnostic message id) and
--       inbox_messages.metadata (per-channel jsonb); adds accounts.enabled.
-- WHY:  Unified Inbox D1 (all channels) + D2 (one store). The 044 baseline ALREADY
--       has multi-account (033) + account provider/provider_config/provider_secret_enc
--       (037/040) + oauth_tokens (031) + account_id on inbox_messages/drafts. So this
--       is the small delta on top — NOT a new accounts/credentials substrate
--       (reuse-first, D5). A dedicated mailbox.credentials table is DEFERRED to
--       Phase 3, which reconciles oauth_tokens + accounts.provider_secret_enc.
-- ADDITIVE + IDEMPOTENT: every column is ADD … IF NOT EXISTS with a DEFAULT, so the
--       running Gmail n8n INSERT (which never names these columns) keeps working;
--       existing rows backfill to channel='email'. No drops, no renames. The runner
--       wraps this file in its own transaction (no BEGIN/COMMIT here).
-- ROLLBACK: ALTER … DROP COLUMN channel/external_id/metadata/enabled + DROP the
--       channel CHECK constraints + the two indexes. All email-path data preserved.

ALTER TABLE mailbox.accounts        ADD COLUMN IF NOT EXISTS channel text    NOT NULL DEFAULT 'email';
ALTER TABLE mailbox.accounts        ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

ALTER TABLE mailbox.inbox_messages  ADD COLUMN IF NOT EXISTS channel     text  NOT NULL DEFAULT 'email';
ALTER TABLE mailbox.inbox_messages  ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE mailbox.inbox_messages  ADD COLUMN IF NOT EXISTS metadata    jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE mailbox.drafts          ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';

-- Constrain `channel` to the known set (D1). Idempotent re-add so the set can be
-- widened in a later migration without a hard failure here.
ALTER TABLE mailbox.accounts       DROP CONSTRAINT IF EXISTS accounts_channel_check;
ALTER TABLE mailbox.inbox_messages DROP CONSTRAINT IF EXISTS inbox_messages_channel_check;
ALTER TABLE mailbox.drafts         DROP CONSTRAINT IF EXISTS drafts_channel_check;

ALTER TABLE mailbox.accounts       ADD CONSTRAINT accounts_channel_check
  CHECK (channel IN ('email','telegram','discord','slack','whatsapp','signal','sms',
                     'teams','matrix','mattermost','irc','line','google_chat','ntfy','simplex'));
ALTER TABLE mailbox.inbox_messages ADD CONSTRAINT inbox_messages_channel_check
  CHECK (channel IN ('email','telegram','discord','slack','whatsapp','signal','sms',
                     'teams','matrix','mattermost','irc','line','google_chat','ntfy','simplex'));
ALTER TABLE mailbox.drafts         ADD CONSTRAINT drafts_channel_check
  CHECK (channel IN ('email','telegram','discord','slack','whatsapp','signal','sms',
                     'teams','matrix','mattermost','irc','line','google_chat','ntfy','simplex'));

-- Unified inbox filters by channel; external_id dedups per channel.
CREATE INDEX IF NOT EXISTS idx_inbox_messages_channel          ON mailbox.inbox_messages (channel);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_channel_external ON mailbox.inbox_messages (channel, external_id);
