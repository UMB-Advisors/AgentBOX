import { z } from 'zod';
import { MAIL_PROVIDERS } from '@/lib/types';

// MBOX-366 (MBOX-162 V5): account registry validation for the operator-facing
// /api/accounts routes (POST create, PATCH update / set-default, DELETE).
// Caddy basic_auth gates these — they are NOT under /api/internal — but we
// zod-validate per STAQPRO-138 anyway.

// Conservative email shape — mirrors lib/schemas/vip.ts. Enough to reject junk
// before it lands as a connected inbox; not RFC-5322 completeness.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// email_address is the stable fan-out key + RAG point-UUID salt, so it is
// lowercased + trimmed at the boundary exactly like a VIP entry. display_label
// is optional free text; empty normalizes to null. provider defaults to gmail
// (the only transport wired end-to-end today; imap/microsoft are registry-only
// placeholders per MBOX-355/356). provider_config is an opaque jsonb bag for
// the non-gmail transports — accepted but not surfaced in the v1 UI.
export const accountCreateSchema = z.object({
  email_address: z
    .string()
    .trim()
    .min(1, 'email_address is required')
    .max(320, 'email_address too long')
    .transform((s) => s.toLowerCase())
    .refine((s) => EMAIL_RE.test(s), { message: 'must be a valid email address' }),
  display_label: z
    .string()
    .max(120, 'display_label too long')
    .trim()
    .optional()
    .transform((s) => (s && s.length > 0 ? s : null)),
  provider: z.enum(MAIL_PROVIDERS).default('gmail'),
  provider_config: z.record(z.string(), z.unknown()).optional(),
});

// PATCH body. All fields optional; `make_default: true` triggers the
// set-default swap (a distinct action from editing label/provider, but routed
// through the same endpoint for the operator's convenience). email_address is
// intentionally absent — it is immutable (see queries-accounts.updateAccount).
export const accountUpdateSchema = z
  .object({
    display_label: z
      .string()
      .max(120, 'display_label too long')
      .trim()
      .nullable()
      .optional()
      .transform((s) =>
        typeof s === 'string' && s.length > 0 ? s : s === undefined ? undefined : null,
      ),
    provider: z.enum(MAIL_PROVIDERS).optional(),
    make_default: z.literal(true).optional(),
  })
  .refine(
    (v) =>
      v.display_label !== undefined || v.provider !== undefined || v.make_default !== undefined,
    { message: 'no fields to update' },
  );

export const accountIdParamSchema = z.object({
  id: z.coerce.number().int().positive('id must be a positive integer'),
});

export type AccountCreate = z.infer<typeof accountCreateSchema>;
export type AccountUpdate = z.infer<typeof accountUpdateSchema>;
export type AccountIdParam = z.infer<typeof accountIdParamSchema>;
