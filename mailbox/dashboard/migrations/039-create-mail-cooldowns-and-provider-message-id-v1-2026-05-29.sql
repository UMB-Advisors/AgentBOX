-- Migration 039 — MBOX-357 (P1 / DR-57): per-(account_id, provider) mail cooldowns
--   + drafts.provider_message_id.
-- WHAT: new mailbox.mail_cooldowns table keyed (account_id, provider) so each
--   connected mailbox×transport gets its OWN rate-limit cooldown bucket — a Gmail
--   429 must not pause an IMAP account, and vice versa. Backfills the live
--   single-row system_state.gmail_rate_limit_until into the (default account,
--   'gmail') row. Also adds drafts.provider_message_id (provider-neutral sent id),
--   backfilled from the n8n-written sent_gmail_message_id.
-- WHY: P0 (migration 037) deferred this until a consumer existed; IMAP (P1) is
--   the first. The Gmail cooldown helpers (lib/queries-system-state.ts) are
--   repointed to this table behavior-preservingly (default account,
--   provider='gmail'); IMAP writes its own row in T5. system_state's
--   gmail_rate_limit_until/_set_at are LEFT in place as read-compat and dropped
--   in P3 — non-breaking.
-- REVERSAL: DROP TABLE mailbox.mail_cooldowns;
--   ALTER TABLE mailbox.drafts DROP COLUMN provider_message_id;
--   (system_state columns untouched.)

CREATE TABLE mailbox.mail_cooldowns (
  account_id integer NOT NULL REFERENCES mailbox.accounts(id),
  provider   text NOT NULL CHECK (provider IN ('gmail', 'imap', 'microsoft')),
  until      timestamptz,
  set_at     timestamptz,
  PRIMARY KEY (account_id, provider)
);

-- Backfill (explicit, per the migration-007 standard): relocate the live global
-- Gmail cooldown into the default account's gmail bucket.
INSERT INTO mailbox.mail_cooldowns (account_id, provider, until, set_at)
SELECT a.id, 'gmail', s.gmail_rate_limit_until, s.gmail_rate_limit_set_at
  FROM mailbox.accounts a
  CROSS JOIN mailbox.system_state s
 WHERE a.is_default AND s.id = 1
ON CONFLICT (account_id, provider) DO NOTHING;

ALTER TABLE mailbox.drafts ADD COLUMN provider_message_id text;

-- Backfill (explicit) from the n8n-written Gmail sent id.
UPDATE mailbox.drafts
   SET provider_message_id = sent_gmail_message_id
 WHERE sent_gmail_message_id IS NOT NULL
   AND provider_message_id IS NULL;
