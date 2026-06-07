-- Migration 041 — MBOX-368: sender-level classification override (sticky rule).
-- WHAT: New mailbox.sender_classification_overrides table. One row per sender
--       email address the operator has explicitly reclassified from the
--       /classifications page. Stores the forced category. The classifier
--       consults it at highest precedence (lib/classification/sender-override.ts,
--       called from app/api/internal/classification-normalize/route.ts) so ALL
--       future inbound from that address is forced to the chosen category before
--       the LLM / noreply / operator-domain preclass paths run. Exact-email match
--       only (operator decision 2026-05-29) — no domain/regex kind.
-- WHY:  MBOX-368 (extends MBOX-123, parent epic MBOX-122 triage-UX). MBOX-123's
--       PATCH /api/drafts/[id]/classification relabels a single draft but is keyed
--       on a draft id, so it cannot touch spam_marketing rows (dropped → no draft)
--       and has no per-sender fan-out. This table is the "future" half of the
--       reclassify-by-sender feature; the "past" half (relabel existing
--       inbox_messages) is a one-shot UPDATE in POST /api/classifications/
--       reclassify-sender that also upserts a row here.
-- ROLLBACK: DROP TABLE mailbox.sender_classification_overrides; revert the
--           sender-override preclass branch in classification-normalize/route.ts
--           + lib/classification/sender-override.ts, the reclassify-sender route
--           (dashboard/app/api/classifications/reclassify-sender/route.ts), the
--           queries (dashboard/lib/queries-sender-overrides.ts), the zod schema
--           (dashboard/lib/schemas/classifications.ts), and the UI control in
--           dashboard/components/ClassificationsClient.tsx. No data carried
--           elsewhere — overrides are self-contained; relabelled inbox rows keep
--           their category (a row drop just stops forcing FUTURE mail).

CREATE TABLE IF NOT EXISTS mailbox.sender_classification_overrides (
  id          BIGSERIAL PRIMARY KEY,
  -- Full sender address, lowercased by the route's zod transform so the preclass
  -- lookup is a case-sensitive equality compare against an already-lowercased
  -- (extractAddress) inbound sender. The unique index below makes re-reclassifying
  -- the same sender an idempotent upsert, not a duplicate.
  email       TEXT NOT NULL,
  -- Forced category. Closed enum kept in lockstep with CATEGORIES in
  -- lib/classification/prompt.ts; the schema-invariants test asserts this set
  -- equals CATEGORIES (same as drafts.classification_category /
  -- classification_log.category).
  category    TEXT NOT NULL,
  -- Optional operator note ("vendor newsletter is actually an inquiry", etc).
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Bumped by the upsert's ON CONFLICT DO UPDATE so the most recent reclassify
  -- of a sender is visible (which category currently wins + when it changed).
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Who set it. Defaults to 'operator' (single-operator-per-appliance); mirrors
  -- the actor convention used by the state_transitions trigger.
  created_by  TEXT NOT NULL DEFAULT 'operator',

  CONSTRAINT sender_classification_overrides_category_check
    CHECK (category IN ('inquiry', 'reorder', 'scheduling', 'follow_up', 'internal', 'spam_marketing', 'escalate', 'unknown')),
  CONSTRAINT sender_classification_overrides_email_not_blank
    CHECK (length(trim(email)) > 0)
);

-- One row per sender address — re-reclassifying the same sender is an upsert
-- (ON CONFLICT (email) DO UPDATE) rather than a duplicate. This is also the
-- index the preclass lookup hits on every inbound classify.
CREATE UNIQUE INDEX IF NOT EXISTS sender_classification_overrides_email_uidx
  ON mailbox.sender_classification_overrides(email);
