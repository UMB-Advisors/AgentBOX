-- Migration 050 — index thread_id on inbox_messages + sent_history.
-- WHAT: two btree indexes used by getThreadHistory / the queue list path.
-- WHY:  every queue render resolves thread history per draft; without these
--       each lookup is a sequential scan on the two largest tables.
CREATE INDEX IF NOT EXISTS inbox_messages_thread_id_idx
  ON mailbox.inbox_messages (thread_id);
CREATE INDEX IF NOT EXISTS sent_history_thread_id_idx
  ON mailbox.sent_history (thread_id);
