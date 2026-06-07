-- Migration 044 — MBOX-162 P5b (sandbox UI port §P5): operator drafting guidelines.
-- WHAT: New mailbox.prompt_rules table. One row per operator-authored drafting
--       rule, scoped per account (the second multi-account dimension, migration
--       033/036). Each rule has a `scope` (always|prefer|avoid|never), the rule
--       text, an optional rationale, an enabled flag, and a version that bumps
--       on content edits (not on enable/disable). Enabled rules are rendered
--       into the per-operator system prompt by rulesSystemBlock
--       (dashboard/lib/drafting/prompt.ts) — the Guidelines tab of /settings/tuning.
-- WHY:  P5b of the Tuning view. Ports the sandbox "Guidelines & Rules" tab to a
--       real persistence + prompt-injection seam. account_id is NOT NULL with no
--       DEFAULT: the table is brand-new/empty so there's nothing to backfill, and
--       the only writer (the /api/prompt-rules CRUD route) always supplies the
--       account via getDefaultAccountId(). Behaviour is single-account today;
--       multi-account editing rides the V3 selector later.
-- ROLLBACK: DROP TABLE mailbox.prompt_rules; then revert the routes
--           (dashboard/app/api/prompt-rules/route.ts + [id]/route.ts), the
--           queries (dashboard/lib/queries-prompt-rules.ts), the zod schemas
--           (dashboard/lib/schemas/prompt-rules.ts), rulesSystemBlock +
--           prompt_rules wiring in dashboard/lib/drafting/prompt.ts and the
--           draft-prompt route, the PROMPT_RULE_SCOPES constant in
--           dashboard/lib/types.ts, and the Guidelines tab in
--           dashboard/app/settings/tuning/*. No data carried elsewhere — rules
--           are not archived into sent_history (the rendered prompt is, via the
--           existing draft snapshot).

CREATE TABLE IF NOT EXISTS mailbox.prompt_rules (
  id          SERIAL PRIMARY KEY,
  -- The owning mailbox. NOT NULL, no DEFAULT — new empty table, app always
  -- supplies the account (getDefaultAccountId on the single-account appliance).
  account_id  INTEGER NOT NULL REFERENCES mailbox.accounts(id),
  -- Closed enum. Keep in lockstep with PROMPT_RULE_SCOPES in
  -- dashboard/lib/types.ts (the schema-invariants test asserts this match).
  --   always  — hard requirement, render as "Always: …"
  --   prefer  — soft preference, "Prefer to: …"
  --   avoid   — soft prohibition, "Avoid: …"
  --   never   — hard prohibition, "Never: …"
  scope       TEXT NOT NULL,
  -- The rule body the operator typed.
  rule        TEXT NOT NULL,
  -- Optional "why this rule" note. '' (not NULL) for the empty case, mirroring
  -- the operator_settings convention — keeps the read path null-free.
  rationale   TEXT NOT NULL DEFAULT '',
  -- Toggling enabled does NOT bump version (it's not a content change).
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  -- Bumped by the route only when scope/rule/rationale change.
  version     INTEGER NOT NULL DEFAULT 1,
  -- Who authored it. NULL = the single-operator-per-appliance default (mirrors
  -- vip_senders.added_by — no per-user identity captured yet).
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT prompt_rules_scope_check CHECK (scope IN ('always', 'prefer', 'avoid', 'never')),
  CONSTRAINT prompt_rules_rule_not_blank CHECK (length(trim(rule)) > 0)
);

-- Draft-time read pattern: fetch enabled rules for one account. A composite
-- index on (account_id, enabled) keeps that scan cheap as the list grows.
CREATE INDEX IF NOT EXISTS prompt_rules_account_enabled_idx
  ON mailbox.prompt_rules (account_id, enabled);
