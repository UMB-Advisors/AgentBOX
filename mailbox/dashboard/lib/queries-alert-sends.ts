// MBOX-185 (FR-22) — mailbox.alert_sends ledger (migration 035) — the
// once-per-code-per-day de-dupe guard for the email threshold-alert push path.
// Mirrors lib/queries-digest.ts's digest_sends pattern exactly: the claim is an
// INSERT ... ON CONFLICT (alert_key) DO NOTHING, so the second call for the
// same key (same red code, same local day) is a no-op. Idempotency lives in the
// DB constraint (alert_sends_alert_key_uniq), not app logic — it holds across
// container restarts and concurrent poll ticks.

import { getKysely } from '@/lib/db';

// Read which alert_keys for a given local day have already been emailed. The
// decision route passes this set to selectAlertsToEmail so it only emails
// not-yet-sent codes. Day-scoped so the query stays a small range scan.
export async function getSentAlertKeysForDay(localDay: string): Promise<Set<string>> {
  const db = getKysely();
  const rows = await db
    .selectFrom('alert_sends')
    .select('alert_key')
    .where('alert_key', 'like', `%:${localDay}`)
    .execute();
  return new Set(rows.map((r) => r.alert_key));
}

export interface AlertSendRecord {
  alert_key: string;
  code: string;
  severity: string;
  recipient: string | null;
  subject: string | null;
}

// The idempotency primitive. Attempts an INSERT ... ON CONFLICT (alert_key) DO
// NOTHING; returns true when THIS call won the key (a row was inserted → the
// email was the first for this code today), false when the key was already
// claimed (skip — already alerted). The race is resolved in Postgres, so
// concurrent poll ticks cannot both win.
export async function recordAlertSendIfFirst(rec: AlertSendRecord): Promise<boolean> {
  const db = getKysely();
  const row = await db
    .insertInto('alert_sends')
    .values({
      alert_key: rec.alert_key,
      code: rec.code,
      severity: rec.severity,
      recipient: rec.recipient,
      subject: rec.subject,
    })
    .onConflict((oc) => oc.column('alert_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  // undefined when ON CONFLICT DO NOTHING suppressed the insert (key already
  // claimed). A defined row → we claimed it.
  return row !== undefined;
}
