-- Migration 029 — MBOX-132: daily digest send ledger.
-- WHAT: New mailbox.digest_sends table. One row per successfully-fired daily
--       digest, keyed by the local calendar day it covers (sent_on DATE). The
--       UNIQUE constraint on sent_on is the once-per-day de-dupe guard: the
--       digest worker records a send by INSERT ... ON CONFLICT (sent_on) DO
--       NOTHING and treats "0 rows inserted" as "already sent today, skip".
--       sent_at keeps the full timestamp for audit; recipient/subject record
--       what went out so a re-fire investigation has the facts on hand.
-- WHY:  MBOX-132 (Phase 2d daily digest worker, parent epic MBOX-122). The
--       MailBOX-Digest n8n schedule workflow gates on this ledger via the
--       dashboard render/decision route (GET /api/internal/digest) so an
--       operator-induced re-fire (or a double schedule tick) cannot double-send.
--       Idempotency lives in the DB constraint, not app logic, so it holds even
--       across container restarts and concurrent calls.
-- ROLLBACK: DROP TABLE mailbox.digest_sends; revert the render/decision route
--           (dashboard/app/api/internal/digest/route.ts), the payload query
--           (dashboard/lib/queries-digest.ts), the HTML renderer
--           (dashboard/lib/digest/render.ts), the zod schema
--           (dashboard/lib/schemas/digest.ts), and remove the MailBOX-Digest
--           workflow (n8n/workflows/MailBOX-Digest.json) + the DIGEST_* env
--           forwards in docker-compose.yml. No data carried elsewhere — the
--           ledger is self-contained (not archived into sent_history).

CREATE TABLE IF NOT EXISTS mailbox.digest_sends (
  id          SERIAL PRIMARY KEY,
  -- The local calendar day this digest covers. The de-dupe key — one digest
  -- per day. Resolved by the worker from the appliance's configured send hour
  -- (DIGEST_SEND_HOUR_LOCAL) against the host clock; passed in by the route so
  -- the "today" boundary is explicit rather than dependent on the DB's TZ.
  sent_on     DATE NOT NULL,
  -- Full send timestamp for audit (sent_on is day-granular; this is the moment).
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Who it went to + the rendered subject line, captured for re-fire forensics.
  -- NULL-tolerant: a future dry-run path may record an intent row without these.
  recipient   TEXT,
  subject     TEXT,

  CONSTRAINT digest_sends_sent_on_uniq UNIQUE (sent_on)
);

-- Read pattern: "have we sent today?" is a point lookup on sent_on; the UNIQUE
-- constraint already provides the supporting index, so no separate index needed.
