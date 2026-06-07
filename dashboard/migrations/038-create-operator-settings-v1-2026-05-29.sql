-- Migration 038 — MBOX-162 P4 (sandbox UI port §4): operator workspace settings.
-- WHAT: mailbox.operator_settings — a singleton row (id=1) holding the operator's
--       right-pane embed config + scheduling link: booking_link,
--       calendar_embed_src, drive_folder_id (all TEXT NOT NULL DEFAULT '').
--       Mirrors the mailbox.system_state singleton shape.
-- WHY:  P4 fills the P1b right-pane stub with embedded Google Calendar/Drive
--       iframes built from these operator-provided values; booking_link is the
--       scheduling URL the operator configures. Decision D3=B — a dedicated
--       singleton table rather than persona.statistical_markers, because
--       settings are not voice/persona data (keeps persona semantically clean).
-- ROLLBACK: DROP TABLE mailbox.operator_settings; then revert the route
--           (app/api/operator-settings), the queries
--           (lib/queries-operator-settings.ts), the zod schema
--           (lib/schemas/operator-settings.ts), the OperatorSettings type in
--           lib/types.ts, the /settings/workspace page, lib/embed.ts, and the
--           RightPane fill (components/RightPane.tsx) + queue-page wiring.

CREATE TABLE IF NOT EXISTS mailbox.operator_settings (
  id                  INT PRIMARY KEY DEFAULT 1,
  -- Scheduling/booking URL (e.g. a Calendly link). Operator-configured; surfaced
  -- in the workspace settings page. '' = unset.
  booking_link        TEXT NOT NULL DEFAULT '',
  -- Google Calendar embed source: a calendar ID / email (templated into the
  -- public calendar/embed URL) OR a full embed URL the operator pasted.
  -- Resolved by buildCalendarEmbedUrl (lib/embed.ts). '' = Calendar tab shows
  -- the configure CTA.
  calendar_embed_src  TEXT NOT NULL DEFAULT '',
  -- Google Drive folder ID (the part after /drive/folders/ in a folder URL) OR
  -- a full URL. Rendered via drive.google.com/embeddedfolderview by
  -- buildDriveEmbedUrl (lib/embed.ts). '' = Drive tab shows the configure CTA.
  drive_folder_id     TEXT NOT NULL DEFAULT '',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT operator_settings_singleton CHECK (id = 1)
);

-- Seed the singleton so reads never hit a missing row (matches system_state).
INSERT INTO mailbox.operator_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
