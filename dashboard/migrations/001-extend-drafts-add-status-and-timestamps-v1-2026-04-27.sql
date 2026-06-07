-- 001-extend-drafts-add-status-and-timestamps-v1-2026-04-27.sql
-- Adds awaiting_cloud status (D-03) and approval/send timestamps to drafts.

ALTER TABLE mailbox.drafts
  DROP CONSTRAINT IF EXISTS drafts_status_check;

ALTER TABLE mailbox.drafts
  ADD CONSTRAINT drafts_status_check
  CHECK (status = ANY (ARRAY[
    'pending',
    'awaiting_cloud',
    'approved',
    'rejected',
    'edited',
    'sent',
    'failed'
  ]));

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
