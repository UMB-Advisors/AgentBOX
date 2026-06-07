import { z } from 'zod';

// MBOX-369 — per-row inbox action request schemas.
//
// Snooze is the only action that carries a body. The client resolves the preset
// (1h / 3h / tomorrow 8am / custom) to an ABSOLUTE instant in the operator's
// browser timezone and sends it as `until` — the server does no timezone math
// (the appliance has no reliable notion of the operator's local tz; the browser
// does). We validate it's a real future instant within a sane horizon.
//
// archive / delete / mark-read take no body — they're pure POSTs keyed on the
// path `[id]`.

const MAX_SNOOZE_DAYS = 365;

export const snoozeBodySchema = z
  .object({
    // ISO-8601 datetime (with offset/Z). z.string().datetime() requires an
    // offset, so the client must send e.g. 2026-05-31T08:00:00-07:00 or ...Z.
    until: z.string().datetime({ offset: true }),
  })
  .refine(
    (b) => {
      const t = Date.parse(b.until);
      return Number.isFinite(t) && t > Date.now();
    },
    { message: 'until must be a future instant', path: ['until'] },
  )
  .refine((b) => Date.parse(b.until) < Date.now() + MAX_SNOOZE_DAYS * 24 * 60 * 60 * 1000, {
    message: `until must be within ${MAX_SNOOZE_DAYS} days`,
    path: ['until'],
  });

export type SnoozeBody = z.infer<typeof snoozeBodySchema>;
