-- Migration 018 — STAQPRO-227 stretch (system-wide Gmail cooldown)
-- WHAT: New singleton mailbox.system_state table. First column is
--       gmail_rate_limit_until — populated by lib/jobs/gmail-ratelimit-sweeper.ts
--       which scans n8n's execution_entity for fresh 429 errors on the
--       Gmail-touching workflows (MailBOX parent + mailbox-send) and parses
--       the "Retry after <ISO>" hint Google returns. Read by the dashboard
--       /retry route before firing the n8n send webhook AND by future
--       MailBOX-cycle gates so the schedule trigger doesn't self-perpetuate
--       a probation period.
-- WHY:  2026-05-04 — STAQPRO-227 per-draft cooldown caught the operator's
--       retry-storm but we observed a second feedback loop: the 5-min
--       MailBOX schedule fires Gmail Get → 429 → +15 min retry-after →
--       next cycle at +5 min hits Gmail again → +15 min from THAT call →
--       lockout never clears. The system-wide column is the single source
--       of truth ("Gmail is angry at us right now"); both retry callers
--       and the schedule fire path consult it before touching Gmail.
-- REVERSAL: DROP TABLE mailbox.system_state. No foreign keys; no data loss
--           beyond the cooldown column itself.

CREATE TABLE mailbox.system_state (
  id                          INT PRIMARY KEY DEFAULT 1,
  gmail_rate_limit_until      TIMESTAMPTZ NULL,
  gmail_rate_limit_set_at     TIMESTAMPTZ NULL,
  CONSTRAINT system_state_singleton CHECK (id = 1)
);

INSERT INTO mailbox.system_state (id) VALUES (1) ON CONFLICT DO NOTHING;
