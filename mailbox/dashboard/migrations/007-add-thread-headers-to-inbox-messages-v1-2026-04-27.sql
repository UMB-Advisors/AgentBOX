-- 007-add-thread-headers-to-inbox-messages-v1-2026-04-27.sql
-- Per D-25 (02-CONTEXT-ADDENDUM-v2-2026-04-27.md): adds in_reply_to and
-- references threading headers to mailbox.inbox_messages so 02-07's SMTP
-- send path can preserve threads in the customer's mail client (FR-MAIL-04).
--
-- Mirrors the columns already added to mailbox.drafts in
-- 02-02-v2 migration 003 (which denormalized email fields onto drafts).
-- Now both tables carry threading headers; n8n IMAP ingestion writes to
-- inbox_messages, the approve flow copies them through to drafts at
-- classification time (already happening per 02-02-v2 migration 003 backfill
-- pattern; new rows post-02-03 will populate inbox_messages.in_reply_to
-- directly from IMAP and JOIN through to drafts on Execute Workflow handoff).
--
-- Note: "references" is a SQL reserved word. All DDL and DML referencing
-- this column MUST quote it: "references". TypeScript code in
-- dashboard/lib/queries.ts already handles the drafts."references" column
-- this way (Phase 1 sub-project pattern).

ALTER TABLE mailbox.inbox_messages
  ADD COLUMN IF NOT EXISTS in_reply_to TEXT;

ALTER TABLE mailbox.inbox_messages
  ADD COLUMN IF NOT EXISTS "references" TEXT;
