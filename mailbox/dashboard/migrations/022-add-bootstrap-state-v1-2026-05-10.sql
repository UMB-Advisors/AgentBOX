-- Migration 022 — STAQPRO-226: Gmail bootstrap mode for first-install rate limiting.
-- WHAT: Three new columns on mailbox.system_state (singleton row from
--       migration 018):
--         - bootstrap_complete BOOL NOT NULL DEFAULT false — gate read by
--           /api/internal/gmail-bootstrap; while false the n8n MailBOX
--           workflow throttles Gmail Get to a smaller per-cycle limit.
--         - bootstrap_started_at TIMESTAMPTZ NULL — set on first Gmail Get
--           call from /api/internal/gmail-cycle-complete.
--         - bootstrap_messages_seen INT NOT NULL DEFAULT 0 — running counter
--           of inbound messages observed during bootstrap. Surfaces in the
--           /status card as "N indexed in bootstrap".
--       Same migration backfills bootstrap_complete=true on appliances that
--       already have inbound history (>0 rows in mailbox.inbox_messages) so
--       live boxes don't retroactively enter bootstrap UI.
-- WHY:  PR #41 (limit:1000 + q=in:inbox) tripped Google's 250 unit/sec
--       per-user Gmail quota on Heron Labs's account, ratcheting the
--       probation window. Even after reverting to limit:50 (commit 3cdfa45),
--       a fresh install with a 200+ unread backlog still lands at the
--       250-unit ceiling on the first cycle. Bootstrap mode caps the first
--       few cycles tighter so a customer-#3 install doesn't replay the
--       lockout. Sister to STAQPRO-227's gmail_rate_limit_until column —
--       same singleton table, same n8n gate pattern.
-- REVERSAL: ALTER TABLE mailbox.system_state
--             DROP COLUMN bootstrap_complete,
--             DROP COLUMN bootstrap_started_at,
--             DROP COLUMN bootstrap_messages_seen;

ALTER TABLE mailbox.system_state
  ADD COLUMN bootstrap_complete BOOL NOT NULL DEFAULT false,
  ADD COLUMN bootstrap_started_at TIMESTAMPTZ NULL,
  ADD COLUMN bootstrap_messages_seen INT NOT NULL DEFAULT 0;

-- Backfill: live appliances with existing inbox history are past bootstrap.
-- Counts mailbox.inbox_messages because that's the table populated by the
-- ingest path; if any row exists, the appliance has been polling Gmail
-- successfully and is not in a fresh-install state.
UPDATE mailbox.system_state
   SET bootstrap_complete = true,
       bootstrap_started_at = NULL,
       bootstrap_messages_seen = 0
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM mailbox.inbox_messages LIMIT 1);
