import { z } from 'zod';

// Shared schema building blocks for STAQPRO-138.

// Path param `[id]` — Next.js gives us a string from the URL; coerce + assert
// it's a positive integer. Rejects non-numeric strings, floats, negatives.
export const idParamSchema = z.object({
  id: z
    .string()
    .regex(/^\d+$/, 'id must be a non-negative integer')
    .transform((s) => parseInt(s, 10))
    .refine((n) => n > 0, 'id must be > 0'),
});

export type IdParam = z.infer<typeof idParamSchema>;

// MBOX-374 — optional `?account=<id>` query param for account-scoped operator
// surfaces (Tuning style + prompt-rules CRUD). Absent/blank → undefined, which
// the query helpers resolve to the seeded default account (single-account
// behaviour unchanged). Mirrors the V3 queue's ?account= convention.
export const accountQuerySchema = z.object({
  account: z.coerce.number().int().positive().optional(),
});

export type AccountQuery = z.infer<typeof accountQuerySchema>;

// Bare domain — one-or-more dot-separated labels, no scheme, no '@', no path.
// Shared by the VIP-sender list (lib/schemas/vip.ts) and auto-send rules
// (lib/schemas/auto-send.ts) so the two can't drift. Inputs are lowercased
// before this is applied.
export const DOMAIN_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
