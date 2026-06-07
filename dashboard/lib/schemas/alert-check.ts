import { z } from 'zod';

// MBOX-185 (FR-22) — alert-check route validation.
//
// GET /api/internal/alert-check takes no body (the route gathers alerts +
// resolves recipient + day itself). POST /api/internal/alert-check/record
// claims the emailed alert_keys in mailbox.alert_sends AFTER a successful Gmail
// send — n8n posts back the exact keys + the recipient/subject it acted on, so
// each claim is anchored to what actually went out.

// '<alert_code>:<YYYY-MM-DD>' — the alert_sends.alert_key de-dupe key.
const alertKeySchema = z
  .string()
  .regex(/^[A-Z0-9_]+:\d{4}-\d{2}-\d{2}$/, "alert_key must be '<CODE>:<YYYY-MM-DD>'");

export const alertCheckRecordBodySchema = z.object({
  // The keys the email actually covered. At least one — n8n only reaches the
  // record node on the send-success branch, which only fires when should_send
  // was true (≥1 alert).
  alert_keys: z.array(alertKeySchema).min(1).max(20),
  recipient: z
    .string()
    .trim()
    .max(320)
    .optional()
    .transform((s) => (s && s.length > 0 ? s : null)),
  subject: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((s) => (s && s.length > 0 ? s : null)),
});

export type AlertCheckRecordBody = z.infer<typeof alertCheckRecordBodySchema>;
