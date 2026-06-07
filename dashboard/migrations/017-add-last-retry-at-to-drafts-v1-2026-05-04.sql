-- Migration 017 — STAQPRO-227
-- WHAT: Add mailbox.drafts.last_retry_at TIMESTAMPTZ. Set on every successful
--       trigger of MailBOX-Send via the dashboard /retry route. Read by the
--       same route to enforce a 5-minute per-draft retry cooldown.
-- WHY:  2026-05-04 — operator manually retried draft 18 five times between
--       15:19 and 18:44 UTC during an active Gmail per-user-per-second rate
--       limit. Each retry was a fresh Gmail Reply API call against an
--       already-probated user — Google extended the cooldown +15 min on every
--       call. Without server-side pacing on the retry path, an enthusiastic
--       operator can keep customer #1 dead in the water for hours by retrying
--       through what should have been a transient hiccup. The retry rate
--       limiter prevents the operator-level feedback loop. Per-system Gmail
--       cooldown is a separate concern (gmail_rate_limit_until — stretch goal
--       in the same ticket).
-- REVERSAL: Drop the column. No data loss — column is purely advisory; no FKs.

ALTER TABLE mailbox.drafts
  ADD COLUMN last_retry_at TIMESTAMPTZ NULL;
