-- Migration 043 — MBOX-370: evolve the sender override into a never-spam allowlist.
-- (Numbered 043, not 042 — MBOX-369's 042-add-inbox-message-actions landed on
--  master first; renumbered before any persistent apply to keep numbers unique.)
-- WHAT: Repurposes mailbox.sender_classification_overrides (migration 041) from a
--       "force this sender to category X" table into mailbox.sender_never_spam —
--       a per-sender allowlist that only means "never let this sender be dropped
--       as spam; let the classifier decide the real category per email." Drops the
--       `category` column + its CHECK; renames the table, the unique index, and the
--       remaining constraints. No data migration needed — 041 shipped hours earlier
--       and the table is empty (the force-category UX was rejected before any rows
--       were committed; see MBOX-370 why).
-- WHY:  MBOX-370 (operator feedback on MBOX-368). Forcing one fixed category is
--       wrong — a sender wrongly dropped as spam can send any non-spam type later.
--       The classifier (lib/classification/sender-allowlist.ts, consulted by the
--       classification-normalize route + classifyOne) now overrides only a
--       spam_marketing verdict (from the model or the noreply heuristic) to
--       `unknown`→cloud for allowlisted senders, surfacing instead of dropping.
-- ROLLBACK: rename back + re-add the category column/CHECK (it will be empty), or
--           DROP TABLE mailbox.sender_never_spam. Revert the allowlist lib, the
--           never-spam guard in classification-normalize/route.ts + classifyOne,
--           the reclassify-sender route/queries, the zod schema, and the UI control.
--           No data carried elsewhere — the allowlist is self-contained.

ALTER TABLE mailbox.sender_classification_overrides
  DROP CONSTRAINT IF EXISTS sender_classification_overrides_category_check;
ALTER TABLE mailbox.sender_classification_overrides
  DROP COLUMN IF EXISTS category;

ALTER TABLE mailbox.sender_classification_overrides
  RENAME CONSTRAINT sender_classification_overrides_email_not_blank
  TO sender_never_spam_email_not_blank;

ALTER INDEX mailbox.sender_classification_overrides_email_uidx
  RENAME TO sender_never_spam_email_uidx;

ALTER TABLE mailbox.sender_classification_overrides
  RENAME TO sender_never_spam;
