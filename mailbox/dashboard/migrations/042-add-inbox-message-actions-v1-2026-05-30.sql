-- Migration 042 — MBOX-369 (child of MBOX-122): per-row Gmail queue actions.
-- WHAT: Adds disposition state to mailbox.inbox_messages so the approval queue
--       can support Gmail-style row actions — archive, delete (trash), mark-read,
--       snooze. archived_at / deleted_at / snooze_until exclude a row from the
--       queue; is_read is a local read flag (clears the unread dot, does NOT
--       remove the row); gmail_action_state tracks the write-through to Gmail
--       (archive/delete/mark-read fan out to n8n → Gmail API) for recoverability,
--       mirroring how send leaves a recoverable state on a remote failure.
-- WHY:  MBOX-369 — the queue is a flat draft-approval list with no inbox-management
--       verbs. Operator request (Dustin, 2026-05-29) to bring Gmail's per-row
--       hover actions into the dashboard. Snooze is appliance-local (Gmail has no
--       snooze API): snooze_until hides the row until it passes, then it resurfaces.
-- NON-BREAKING: all columns nullable or defaulted; existing INSERTers (n8n's
--       inbox-messages route) are untouched — new rows default to is_read=false,
--       no archive/delete/snooze. Queue queries add the exclusion WHERE in app code.
-- ROLLBACK: drop the five columns and the partial snooze index. Non-destructive —
--       no existing data is rewritten (every row gets the column defaults).

ALTER TABLE mailbox.inbox_messages
  ADD COLUMN IF NOT EXISTS archived_at        TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS deleted_at         TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS snooze_until       TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS is_read            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gmail_action_state TEXT NULL;

-- gmail_action_state is the write-through status for the last archive/delete/
-- mark-read fan-out. NULL = no Gmail write outstanding (e.g. snooze, or a fresh
-- row). 'pending' = webhook fired, awaiting confirm; 'ok' = Gmail applied;
-- 'failed' = Gmail write errored, row left recoverable for operator retry.
ALTER TABLE mailbox.inbox_messages
  DROP CONSTRAINT IF EXISTS inbox_messages_gmail_action_state_check;
ALTER TABLE mailbox.inbox_messages
  ADD CONSTRAINT inbox_messages_gmail_action_state_check
  CHECK (gmail_action_state IS NULL OR gmail_action_state IN ('pending', 'ok', 'failed'));

-- Resurface sweep ("snooze_until < now()") + queue-exclusion both probe the
-- small set of currently-snoozed rows; a partial index keeps that cheap as the
-- table grows.
CREATE INDEX IF NOT EXISTS inbox_messages_snooze_until_idx
  ON mailbox.inbox_messages (snooze_until)
  WHERE snooze_until IS NOT NULL;
