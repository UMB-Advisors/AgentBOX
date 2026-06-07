// MBOX-132 — local-day resolution for the digest de-dupe key.
//
// The digest is once-per-CALENDAR-DAY. The de-dupe key (digest_sends.sent_on)
// is a DATE in the appliance's local timezone — n8n's schedule trigger fires at
// DIGEST_SEND_HOUR_LOCAL in the host TZ (timezone open question resolved in
// favour of appliance host TZ for v1: fewer moving parts, the operator and the
// box share a locale on a single-tenant appliance). So "today" is just the
// host-local calendar date at fire time.
//
// We format YYYY-MM-DD from the host-local Date parts (not toISOString, which
// is UTC and would roll the day at the wrong boundary for non-UTC appliances).

export function localDay(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
