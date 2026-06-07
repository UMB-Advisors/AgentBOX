-- Migration 035 — MBOX-185 (FR-22): operator threshold-alert email ledger.
-- WHAT: New mailbox.alert_sends table. One row per alert-email actually fired,
--       keyed by a de-dupe key (alert_key TEXT) that encodes the alert code +
--       the local calendar day it fired for (e.g. 'MEMORY_PRESSURE:2026-05-28').
--       The UNIQUE constraint on alert_key is the once-per de-dupe guard,
--       mirroring migration 029's digest_sends pattern exactly: the alert push
--       path records a send by INSERT ... ON CONFLICT (alert_key) DO NOTHING and
--       treats "0 rows inserted" as "already alerted for this code today, skip".
--       So a red threshold that stays breached across many poll cycles emails
--       the operator once per day, not every cycle. severity captures what fired.
-- WHY:  MBOX-185 closes FR-22's missing notification PUSH path. The STAQPRO-128
--       alerts compute (surfaced on GET /api/system/status) was pull-only; this
--       table is the idempotency primitive behind the new email push path
--       (GET /api/internal/alert-check decides + renders, the MailBOX-AlertCheck
--       n8n workflow sends via appliance Gmail OAuth, then POSTs back to
--       /api/internal/alert-check/record to claim the key). De-dupe lives in the
--       DB constraint, not app logic, so it holds across container restarts and
--       concurrent poll ticks — same guarantee digest_sends gives.
-- ROLLBACK: DROP TABLE mailbox.alert_sends; revert the decision/record routes
--           (dashboard/app/api/internal/alert-check/{route.ts,record/route.ts}),
--           the de-dupe query helpers (dashboard/lib/queries-alert-sends.ts), the
--           push decision logic (dashboard/lib/alert-push.ts), and remove the
--           MailBOX-AlertCheck workflow (n8n/workflows/MailBOX-AlertCheck.json).
--           No data carried elsewhere — the ledger is self-contained.

CREATE TABLE IF NOT EXISTS mailbox.alert_sends (
  id          SERIAL PRIMARY KEY,
  -- De-dupe key: '<alert_code>:<YYYY-MM-DD-local>'. One alert email per code
  -- per local day. Built by the decision route so the "today" boundary is
  -- explicit (matches digest_sends.sent_on resolution against the host clock)
  -- rather than dependent on the DB's TZ.
  alert_key   TEXT NOT NULL,
  -- The alert code that fired (mailbox alerts AlertCode union — e.g.
  -- MEMORY_PRESSURE, GMAIL_RATE_LIMITED). Denormalized out of alert_key for
  -- easy filtering in forensics.
  code        TEXT NOT NULL,
  -- 'alarm' (red) — the only severity that pushes email in v1. Stored so a
  -- future warn-also-emails policy can coexist in the same ledger.
  severity    TEXT NOT NULL,
  -- Full send timestamp for audit (alert_key day is day-granular; this is the
  -- moment the email went out).
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Who it went to + the rendered subject, captured for re-fire forensics.
  recipient   TEXT,
  subject     TEXT,

  CONSTRAINT alert_sends_alert_key_uniq UNIQUE (alert_key)
);

-- Read pattern: "have we alerted for this code today?" is a point lookup on
-- alert_key; the UNIQUE constraint already provides the supporting index, so
-- no separate index needed.
