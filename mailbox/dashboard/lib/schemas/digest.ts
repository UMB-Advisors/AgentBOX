import { z } from 'zod';

// MBOX-132 — digest route validation.
//
// GET /api/internal/digest takes no body (the route resolves recipient + day
// itself). POST /api/internal/digest/record claims the day in the ledger AFTER
// a successful Gmail send — n8n posts back the sent_on it acted on so the claim
// is anchored to the exact day the decision was computed for (no clock skew
// between the GET and the POST landing on different sides of midnight).

// YYYY-MM-DD local calendar day (the digest_sends.sent_on key).
const localDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'sent_on must be a YYYY-MM-DD date');

export const digestRecordBodySchema = z.object({
  sent_on: localDaySchema,
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

export type DigestRecordBody = z.infer<typeof digestRecordBodySchema>;
