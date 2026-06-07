-- 025-add-send-attempt-at-to-drafts-v1-2026-05-22.sql
-- WHAT: Add `send_attempt_at TIMESTAMPTZ NULL` to mailbox.drafts.
-- WHY:  Closes the MailBOX-Send partial-failure idempotency hole. The existing
--       `Already Sent?` IF reads `sent_gmail_message_id` which is only written
--       by `Mark Sent` AFTER Gmail Reply has already sent the email. If Mark
--       Sent crashes between Gmail Reply success and DB commit, the draft is
--       left at status='approved' with sent_gmail_message_id=NULL, so a retry
--       re-fires Gmail Reply and sends a duplicate. The 2026-05-22 incident
--       (draft 212 sent 3x to Dustin on M2 — execs 5202/5203/5209) was caused
--       by exactly this. `send_attempt_at` is written BEFORE Gmail Reply via a
--       CAS-style `UPDATE ... WHERE send_attempt_at IS NULL RETURNING id`. If
--       the CAS returns 0 rows, the workflow refuses to send.
-- REVERSAL: `ALTER TABLE mailbox.drafts DROP COLUMN send_attempt_at;` is safe
--       — column is additive, no existing code reads it until the workflow
--       update lands.

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS send_attempt_at TIMESTAMPTZ NULL;

-- Partial index for the workflow's CAS lookup and the dashboard's
-- StuckApproved "send_attempt_at set but never confirmed" query.
CREATE INDEX IF NOT EXISTS idx_drafts_send_attempt_at
  ON mailbox.drafts (send_attempt_at)
  WHERE send_attempt_at IS NOT NULL;
