import { z } from 'zod';
import { DOMAIN_RE } from '@/lib/schemas/common';
import { VIP_SENDER_KINDS } from '@/lib/types';

// MBOX-134: VIP sender list validation (POST /api/vip-senders,
// DELETE /api/vip-senders/[id]). Match semantics are exact-email or
// domain-suffix only — NO regex (open question resolved in the issue).
//
// `email_or_domain` is normalized to lowercase + trimmed here so the urgency
// SQL can compare against an already-lowercased draft sender (the evaluator
// lowercases the draft side too — see lib/urgency.ts). The DB also CHECKs the
// value is non-blank and kind is one of ('email','domain') (migration 028).

// Conservative email shape — we don't need RFC-5322 completeness, just enough
// to reject obvious junk before it lands in the list. A single '@' with a
// dotted domain on the right.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// DOMAIN_RE is shared from lib/schemas/common.ts (also used by auto-send rules).

export const vipSenderCreateSchema = z
  .object({
    email_or_domain: z
      .string()
      .trim()
      .min(1, 'email_or_domain is required')
      .max(320, 'email_or_domain too long')
      .transform((s) => s.toLowerCase()),
    kind: z.enum(VIP_SENDER_KINDS),
    // Optional free-text note. Empty string is normalized to null so the row
    // stores a clean NULL rather than ''.
    note: z
      .string()
      .max(500, 'note too long')
      .trim()
      .optional()
      .transform((s) => (s && s.length > 0 ? s : null)),
  })
  // Cross-field: the value has to actually look like the declared kind. This is
  // the regex-free gate — exact email vs bare domain, nothing fancier.
  .refine((v) => (v.kind === 'email' ? EMAIL_RE.test(v.email_or_domain) : true), {
    path: ['email_or_domain'],
    message: 'must be a valid email address when kind is "email"',
  })
  .refine((v) => (v.kind === 'domain' ? DOMAIN_RE.test(v.email_or_domain) : true), {
    path: ['email_or_domain'],
    message: 'must be a bare domain (e.g. acme.com) when kind is "domain"',
  });

// DELETE /api/vip-senders/[id] — numeric id path param.
export const vipSenderIdParamSchema = z.object({
  id: z.coerce.number().int().positive('id must be a positive integer'),
});

export type VipSenderCreate = z.infer<typeof vipSenderCreateSchema>;
export type VipSenderIdParam = z.infer<typeof vipSenderIdParamSchema>;
