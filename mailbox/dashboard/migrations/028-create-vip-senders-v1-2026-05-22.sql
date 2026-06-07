-- Migration 028 — MBOX-134: VIP sender list backing the urgency engine.
-- WHAT: New mailbox.vip_senders table. One row per allow-listed counterparty,
--       either an exact email ('email' kind) or a whole domain ('domain' kind).
--       The urgency evaluator (dashboard/lib/urgency.ts) flags any queued draft
--       whose sender matches a VIP row as urgent (the 'vip' signal). Match
--       semantics are exact-email OR domain-suffix — NO regex (open question
--       resolved per the issue: email + domain modes only).
-- WHY:  MBOX-134 (Phase 2b, parent epic MBOX-122 triage-UX). Drives both the
--       per-draft urgency badge (sandbox design landed in MBOX-128) and the
--       dashboard-wide red-flag count (GET /api/queue/urgent-count). The age
--       thresholds open question is resolved in favour of ENV (URGENCY_AGE_
--       HOURS_* in lib/urgency.ts + the compose environment block) — there is
--       deliberately NO urgency_thresholds table; fewer moving parts for v1.
-- ROLLBACK: DROP TABLE mailbox.vip_senders; revert the routes
--           (dashboard/app/api/vip-senders/route.ts + [id]/route.ts and
--           dashboard/app/api/queue/urgent-count/route.ts), the queries
--           (dashboard/lib/queries-vip.ts + getQueueWithUrgency in
--           dashboard/lib/queries.ts), the evaluator (dashboard/lib/urgency.ts),
--           the zod schemas (dashboard/lib/schemas/vip.ts), the VIP_SENDER_KINDS
--           constant in dashboard/lib/types.ts, and the settings page
--           (dashboard/app/settings/vip/*). No data carried elsewhere — the VIP
--           list is self-contained (not archived into sent_history).

CREATE TABLE IF NOT EXISTS mailbox.vip_senders (
  id             SERIAL PRIMARY KEY,
  -- The matchable value. For kind='email' this is a full address
  -- (e.g. 'ceo@acme.com'); for kind='domain' it is a bare domain
  -- (e.g. 'acme.com'). Stored lowercased by the route's zod transform so the
  -- urgency SQL can do a case-sensitive equality / suffix compare against an
  -- already-lowercased draft sender. The unique index below dedupes within a
  -- kind.
  email_or_domain TEXT NOT NULL,
  -- Closed enum. Keep in lockstep with VIP_SENDER_KINDS in
  -- dashboard/lib/types.ts; the schema-invariants test asserts this. NO 'regex'
  -- value — match semantics are exact-email or domain-suffix only (MBOX-134
  -- open question).
  kind            TEXT NOT NULL,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Who added the entry. NULL = the single-operator-per-appliance default
  -- (no per-user identity captured yet); mirrors the user_filter_preferences
  -- operator_id convention (migration 026).
  added_by        TEXT,
  -- Optional free-text note ("escalations", "key account", etc). NULL allowed.
  note            TEXT,

  CONSTRAINT vip_senders_kind_check CHECK (kind IN ('email', 'domain')),
  CONSTRAINT vip_senders_value_not_blank CHECK (length(trim(email_or_domain)) > 0)
);

-- One row per (value, kind) — re-adding the same entry is a no-op upsert, not
-- a duplicate. An email and a domain that happen to share a string are distinct
-- rows (different kind), so the kind is part of the key.
CREATE UNIQUE INDEX IF NOT EXISTS vip_senders_value_kind_uidx
  ON mailbox.vip_senders(email_or_domain, kind);

-- Read pattern: the urgency SQL joins every queued draft against the full VIP
-- list (small table) split by kind. A plain index on kind keeps the
-- kind-partitioned scans cheap as the list grows.
CREATE INDEX IF NOT EXISTS vip_senders_kind_idx
  ON mailbox.vip_senders(kind);
