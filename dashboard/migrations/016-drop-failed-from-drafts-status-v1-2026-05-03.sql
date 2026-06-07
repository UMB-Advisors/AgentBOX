-- Migration 016 — STAQPRO-202
-- WHAT: Drop 'failed' from mailbox.drafts.status CHECK allowlist. Backfills any
--       residual rows at status='failed' with sent_gmail_message_id IS NULL up
--       to 'approved' so the operator can recover them via the StuckApproved UI
--       (rows where the outbound idempotency key is set are left alone defensively
--       — column was added today in migration 015 so this branch should be empty).
-- WHY:  Yesterday (2026-05-02) the live MailBOX-Send n8n workflow was republished
--       without the Mark Failed node — n8n 2.14.2's SDK self-loop bug made wiring
--       Gmail Reply's error output unsafe. Send-side failures now leave the row
--       at status='approved' and the StuckApproved UI handles operator recovery.
--       Removing 'failed' from the CHECK + dashboard surface kills the dead-code
--       paths that yesterday's hot-fix left behind.
-- REVERSAL: Re-add 'failed' to the CHECK; operator-flipped rows can't be
--           auto-reverted (no audit shadow of the original status).

-- Backfill: only rows with no outbound idempotency key — sending again is safe.
UPDATE mailbox.drafts
   SET status = 'approved',
       updated_at = now()
 WHERE status = 'failed'
   AND sent_gmail_message_id IS NULL;

-- Replace the CHECK constraint. Pattern matches migration 003.
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
    'sent'
  ]));
