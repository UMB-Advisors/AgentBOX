-- Migration 031 — MBOX-130 + MBOX-129: shared Google OAuth token storage and a
--                  per-draft calendar-unavailable flag.
-- WHAT: (1) New mailbox.oauth_tokens table — one row per (provider) holding an
--           AES-256-GCM-encrypted refresh token, the granted scope, the
--           connected account email, and a last-fetched timestamp. One row per
--           provider ('google_calendar', 'google_tasks', 'google_drive', …) —
--           providers are key-separated: each integration gets its OWN row /
--           scope, never sharing a token (MBOX-130 key-separation discipline).
--       (2) New boolean mailbox.drafts.scheduling_calendar_unavailable (default
--           false) — set true when a `scheduling` draft tried to pre-read the
--           calendar but the fetch failed (token expired / rate limited /
--           gated), so the dashboard can surface the "calendar context was
--           unavailable" toast and the draft falls back to no-calendar
--           boilerplate.
-- WHY:  MBOX-130 (Calendar context for scheduling drafts) wires a read-only
--       Google Calendar pre-read at draft time; MBOX-129 (task-creation
--       handoff) reuses the SAME oauth_tokens table for Google Tasks. The two
--       issues were grouped because they share this Google-API plumbing.
--       STAQPRO-212 (Drive OAuth + AES-256-GCM token storage) had not landed
--       when this picked up, so the token storage is introduced here as the
--       shared peer table all Google integrations read (see
--       dashboard/lib/oauth/google.ts). Stored encrypted-at-rest because the
--       refresh token grants long-lived calendar/tasks access; encryption key
--       is MAILBOX_OAUTH_TOKEN_KEY (32-byte hex), separate from the
--       MAILBOX_OAUTH_STATE_SECRET used for the connect-flow state HMAC.
-- ROLLBACK: DROP TABLE mailbox.oauth_tokens;
--           ALTER TABLE mailbox.drafts DROP COLUMN scheduling_calendar_unavailable;
--           plus revert lib/oauth/google.ts, lib/calendar/*, lib/tasks/*, the
--           push + connect routes, and the OAUTH_PROVIDERS / TASK_PROVIDERS
--           consts in lib/types.ts. No data carried elsewhere — tokens are
--           re-obtainable by reconnecting the Google account.

CREATE TABLE IF NOT EXISTS mailbox.oauth_tokens (
  -- One row per provider on a single-operator appliance. The provider string is
  -- the key-separation boundary: each Google integration (calendar / tasks /
  -- drive) holds its OWN scope + token, so revoking one never touches another.
  provider              TEXT PRIMARY KEY,
  -- AES-256-GCM ciphertext of the refresh token, base64. The IV + auth tag are
  -- packed in alongside the ciphertext by lib/oauth/google.ts:encryptToken
  -- (format: base64(iv).base64(tag).base64(ciphertext)) — never store the
  -- plaintext refresh token. NULL only transiently during a partially-completed
  -- connect flow; a connected provider always has a value.
  refresh_token_enc     TEXT,
  -- The OAuth scope actually granted (space-joined), e.g.
  -- 'https://www.googleapis.com/auth/calendar.readonly'. Recorded so the
  -- settings UI can show what access the operator granted and the fetch path
  -- can fail fast if the scope is narrower than the integration needs.
  scope                 TEXT,
  -- The connected Google account email (surfaced in the settings UI). NULL until
  -- the connect flow resolves the userinfo email.
  account_email         TEXT,
  -- Last time the integration successfully fetched data with this token
  -- (calendar events / tasks list). Surfaced as "last fetched" in settings.
  -- NULL until the first successful fetch.
  last_fetched_at       TIMESTAMPTZ,
  connected_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT oauth_tokens_provider_not_blank CHECK (length(trim(provider)) > 0)
);

-- MBOX-130 — per-draft signal that the calendar pre-read failed for this
-- `scheduling` draft. Set true by the draft-prompt path on a fetch failure
-- (token expired / rate-limited / cloud-gated) so the operator UI can surface a
-- toast and the draft falls back to the no-calendar prompt. Default false:
-- non-scheduling drafts and successful pre-reads leave it false. Non-gating —
-- mirrors the rag_retrieval_reason convention (a draft is never blocked by a
-- failed augmentation read).
ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS scheduling_calendar_unavailable BOOLEAN NOT NULL DEFAULT false;
