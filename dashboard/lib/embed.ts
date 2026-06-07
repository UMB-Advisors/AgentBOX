// dashboard/lib/embed.ts
//
// MBOX-162 P4 (sandbox UI port §4) — pure builders that turn operator-configured
// Calendar/Drive sources into iframe-able embed URLs for the queue right pane.
// Ported (logic only, no fixtures) from the sandbox's App.tsx
// buildCalendarEmbedUrl / buildDriveEmbedUrl.
//
// Both Google Calendar and Google Drive's main apps refuse to iframe
// (X-Frame-Options: SAMEORIGIN); the /calendar/embed and
// /drive/embeddedfolderview endpoints used here are the supported public
// iframe paths. These are SEPARATE from the calendar.readonly OAuth token
// (STAQPRO-210/212; deeper calendar = STAQPRO-295) — a public embed needs the
// source calendar's sharing set to "see all event details", not an OAuth scope.

// Build the iframe-friendly embed URL from a calendar source the operator
// pasted in settings. A full http(s) URL is trusted as-is (lets the operator
// paste a preformatted embed URL with their own ctz / mode params); otherwise
// the input is treated as a calendar ID / email and templated into Google's
// public embed path. Non-URL input is always run through encodeURIComponent, so
// there's no way to inject a foreign scheme via this branch.
export function buildCalendarEmbedUrl(src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const tz =
    typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : 'America/Los_Angeles';
  const params = new URLSearchParams({
    src: trimmed,
    ctz: tz,
    mode: 'AGENDA',
    showTitle: '0',
    showCalendars: '0',
    showTabs: '0',
    showPrint: '0',
    showNav: '1',
    showDate: '1',
  });
  return `https://calendar.google.com/calendar/embed?${params.toString()}`;
}

// Drive folder embed URL. The operator pastes a folder ID (the chunk after
// /drive/folders/ in any Drive URL) — we build the embeddedfolderview URL which
// IS iframe-able and read-only by design. A full http(s) URL is trusted as-is.
// #list = list view.
export function buildDriveEmbedUrl(folderId: string): string | null {
  const trimmed = folderId.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(trimmed)}#list`;
}

// The "open in a new tab" target for the right-pane header — links to the full
// Google app for the active tab (the embed is read-only/limited; this is the
// escape hatch to the real thing).
export function calendarExternalUrl(): string {
  return 'https://calendar.google.com/calendar/u/0/r';
}

export function driveExternalUrl(folderId: string): string {
  const trimmed = folderId.trim();
  if (!trimmed) return 'https://drive.google.com/drive/u/0/my-drive';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://drive.google.com/drive/folders/${encodeURIComponent(trimmed)}`;
}
