-- Migration 032 — MBOX-16 (FR-23): configurable auto-send rules + audit trail.
-- (Renumbered 031→032: MBOX-130/129 took 031 for oauth_tokens in a parallel branch.)
-- WHAT: Two new tables. mailbox.auto_send_rules holds operator-defined rules
--       (condition: category / sender_domain / min_confidence / time-of-day
--       window → action: auto_send | queue | drop), each with an enabled flag,
--       a priority (lower = evaluated first), and an optional shadow_until
--       timestamp that downgrades an auto_send rule to log-only ("shadow mode")
--       until the cooldown passes. mailbox.auto_send_audit is the append-only
--       trail recording, per finalized draft, which rule (if any) matched, the
--       rule's declared action, the EFFECTIVE action actually taken (shadow
--       downgrades auto_send→queue), whether it ran in shadow, and a reason.
-- WHY:  MBOX-16 / FR-23 (§1 missing per Isa's audit). Today every draft is
--       manual-only; the PRD allows conservative auto-send. Default-safe: a
--       fresh install has ZERO rules → nothing matches → every draft falls
--       through to the all-manual queue (FR-23 §4). The evaluator
--       (dashboard/lib/auto-send/rules.ts) layers HARD guardrails on top of any
--       config (never auto-send escalate/unknown, never below the 0.75
--       confidence floor, never when drafts.auto_send_blocked) so a misconfigured
--       rule cannot send escalations or low-confidence drafts. Auto-send reuses
--       transitionToApprovedAndSend so it inherits the Gmail cooldown circuit
--       breaker, the send_attempt_at idempotency lock, and the migration-009
--       state_transitions audit trigger (actor='auto').
-- ROLLBACK: DROP TABLE mailbox.auto_send_audit; DROP TABLE mailbox.auto_send_rules;
--           then revert the routes (dashboard/app/api/auto-send-rules/*), the
--           queries (dashboard/lib/queries-auto-send.ts), the evaluator
--           (dashboard/lib/auto-send/rules.ts), the zod schemas
--           (dashboard/lib/schemas/auto-send.ts), the AUTO_SEND_ACTIONS constant
--           in dashboard/lib/types.ts, and the draft-finalize wiring
--           (dashboard/app/api/internal/draft-finalize/route.ts). The existing
--           (unused since migration 003) drafts.auto_send_blocked column is left
--           in place — it predates this feature and carries no data elsewhere.

CREATE TABLE IF NOT EXISTS mailbox.auto_send_rules (
  id              SERIAL PRIMARY KEY,
  -- Human label shown in the operator UI. Required, non-blank.
  name            TEXT NOT NULL,
  -- Master on/off for the rule. A disabled rule is skipped entirely (it does
  -- not even produce a shadow-audit row). Default TRUE so a freshly-created
  -- rule is live unless the operator also sets a shadow window.
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  -- Evaluation order. Lower numbers are evaluated first; the FIRST matching
  -- rule wins (stop-on-first-match). Ties broken by id ASC (creation order).
  priority        INTEGER NOT NULL DEFAULT 100,
  -- What to do when this rule matches. 'auto_send' funnels the draft through
  -- transitionToApprovedAndSend (subject to the code-side hard guardrails);
  -- 'queue' is the explicit all-manual action (leave at status='pending');
  -- 'drop' marks the draft auto_send_blocked + rejects it without sending.
  action          TEXT NOT NULL,
  -- ── Conditions. A NULL condition column means "don't constrain on this
  --    dimension" (matches anything). A rule with all-NULL conditions matches
  --    every draft (a deliberate catch-all the operator can author). ──
  -- Match only this classification category (one of the 8 CATEGORIES). NULL =
  -- any category. The code-side guardrail still forbids auto_send for
  -- 'escalate'/'unknown' regardless of what a rule names.
  category        TEXT,
  -- Match only senders in this bare domain (e.g. 'acme.com'); compared
  -- case-insensitively against the part after '@' in the draft sender. NULL =
  -- any sender. Stored lowercased by the route's zod transform.
  sender_domain   TEXT,
  -- Minimum classification confidence (0..1) required to match. NULL = no
  -- floor BEYOND the code-side hard 0.75 auto-send floor (which always applies
  -- for the auto_send action). A rule may set this HIGHER than 0.75 to be more
  -- conservative; it can never effectively lower it for auto_send.
  min_confidence  NUMERIC(4,3),
  -- Time-of-day window (operator-local, GENERIC_TIMEZONE) the rule is active
  -- in, as minutes-from-midnight [start, end). NULL/NULL = always. Supports a
  -- wrap-around window (start > end means e.g. 22:00→06:00 overnight).
  active_from_min INTEGER,
  active_to_min   INTEGER,
  -- Shadow mode (FR-23 risk mitigation): while NOW() < shadow_until, an
  -- 'auto_send' rule is DOWNGRADED to 'queue' at evaluation time and the audit
  -- row records shadow=true + matched_action='auto_send' / effective_action=
  -- 'queue'. Lets an operator watch what a new rule WOULD have sent for a
  -- cooldown window (the issue suggests 24h) before trusting it. NULL = not in
  -- shadow (acts immediately). Ignored for 'queue'/'drop' actions (nothing to
  -- shadow — they don't send).
  shadow_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Who authored the rule. NULL = the single-operator-per-appliance default
  -- (mirrors vip_senders.added_by / user_filter_preferences.operator_id).
  created_by      TEXT,

  CONSTRAINT auto_send_rules_action_check
    CHECK (action IN ('auto_send', 'queue', 'drop')),
  CONSTRAINT auto_send_rules_name_not_blank
    CHECK (length(trim(name)) > 0),
  CONSTRAINT auto_send_rules_category_check
    CHECK (category IS NULL OR category IN (
      'inquiry', 'reorder', 'scheduling', 'follow_up',
      'internal', 'spam_marketing', 'escalate', 'unknown')),
  CONSTRAINT auto_send_rules_min_confidence_range
    CHECK (min_confidence IS NULL OR (min_confidence >= 0 AND min_confidence <= 1)),
  -- Minutes-from-midnight are in [0, 1440). Both must be set together or both
  -- NULL (a half-open window is a config bug).
  CONSTRAINT auto_send_rules_time_window_range
    CHECK (
      (active_from_min IS NULL AND active_to_min IS NULL)
      OR (active_from_min BETWEEN 0 AND 1439 AND active_to_min BETWEEN 0 AND 1439)
    )
);

-- Evaluation reads all enabled rules ordered by (priority, id). The partial
-- index keeps that scan cheap and skips disabled rules.
CREATE INDEX IF NOT EXISTS auto_send_rules_enabled_priority_idx
  ON mailbox.auto_send_rules(priority, id)
  WHERE enabled = TRUE;

-- Append-only audit of every auto-send evaluation that ran for a finalized
-- draft. This is FR-23 §3 ("audit trail of which rule fired for each
-- message"). It is SEPARATE from mailbox.state_transitions (which audits the
-- status flip itself, actor='auto'); this table records the rule decision even
-- when no send happened (queue / drop / shadow / no-match).
CREATE TABLE IF NOT EXISTS mailbox.auto_send_audit (
  id               BIGSERIAL PRIMARY KEY,
  draft_id         INTEGER NOT NULL REFERENCES mailbox.drafts(id) ON DELETE CASCADE,
  -- The rule that matched, or NULL when no enabled rule matched (the default
  -- all-manual fall-through). ON DELETE SET NULL so deleting a rule doesn't
  -- destroy the historical record of what it did.
  rule_id          INTEGER REFERENCES mailbox.auto_send_rules(id) ON DELETE SET NULL,
  -- Snapshot of the rule name at evaluation time (survives rule deletion).
  rule_name        TEXT,
  -- The action the matched rule DECLARED (auto_send | queue | drop), or
  -- 'queue' for the no-match default.
  matched_action   TEXT NOT NULL,
  -- The action actually TAKEN after guardrails + shadow downgrade
  -- (auto_send | queue | drop). When matched_action='auto_send' was blocked by
  -- a guardrail or shadow, this is 'queue'.
  effective_action TEXT NOT NULL,
  -- TRUE when the matched auto_send rule was in its shadow window (logged but
  -- not sent).
  shadow           BOOLEAN NOT NULL DEFAULT FALSE,
  -- Machine-readable why, e.g. 'matched', 'no_rule_match',
  -- 'guardrail_escalate_category', 'guardrail_low_confidence',
  -- 'guardrail_auto_send_blocked', 'shadow_mode', 'send_failed'.
  reason           TEXT NOT NULL,
  evaluated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT auto_send_audit_matched_action_check
    CHECK (matched_action IN ('auto_send', 'queue', 'drop')),
  CONSTRAINT auto_send_audit_effective_action_check
    CHECK (effective_action IN ('auto_send', 'queue', 'drop'))
);

CREATE INDEX IF NOT EXISTS auto_send_audit_draft_id_idx
  ON mailbox.auto_send_audit(draft_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS auto_send_audit_rule_id_idx
  ON mailbox.auto_send_audit(rule_id);
