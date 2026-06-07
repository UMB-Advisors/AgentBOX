-- Migration 015 — STAQPRO-202
-- WHAT: Add `mailbox.drafts.sent_gmail_message_id` (TEXT, nullable). Stores
--       the Gmail message ID returned by Gmail Reply on a successful send.
-- WHY:  Used as the OUTBOUND idempotency key by `MailBOX-Send` so a retry
--       of an already-sent draft short-circuits to "Respond Success" instead
--       of firing Gmail Reply a second time. Distinct from `drafts.message_id`,
--       which holds the INBOUND Gmail id of the original email being replied to.
-- REVERSAL: ALTER TABLE mailbox.drafts DROP COLUMN sent_gmail_message_id;

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS sent_gmail_message_id TEXT;

COMMENT ON COLUMN mailbox.drafts.sent_gmail_message_id IS
  'Gmail message ID of the OUTBOUND reply (set by MailBOX-Send Mark Sent). '
  'Outbound idempotency key — non-null means a Gmail Reply already fired for '
  'this draft. Distinct from drafts.message_id (inbound).';
