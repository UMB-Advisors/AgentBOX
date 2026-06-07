import { z } from 'zod';
import { CATEGORIES } from '@/lib/classification/prompt';
import { DOMAIN_RE } from '@/lib/schemas/common';
import { AUTO_SEND_ACTIONS } from '@/lib/types';

// MBOX-16 / FR-23 — auto-send rule validation (POST/PATCH /api/auto-send-rules,
// DELETE /api/auto-send-rules/[id]). The DB CHECK constraints in migration 031
// are the backstop; these schemas reject obvious junk at the route boundary and
// normalize sender_domain to lowercase so the evaluator's case-insensitive
// match is cheap.

// DOMAIN_RE is shared from lib/schemas/common.ts — sender_domain has the same
// shape as a VIP domain entry, so the two can't drift.

const MINUTES_IN_DAY = 1440;

// Optional time-of-day window expressed as "HH:MM" 24h strings in the rule UI,
// converted to minutes-from-midnight for storage. Both or neither.
const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24h)')
  .transform((s) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  });

export const autoSendRuleCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'name is required').max(120, 'name too long'),
    enabled: z.boolean().optional().default(true),
    // Lower = evaluated first. Bounded to keep the ordering sane.
    priority: z.coerce.number().int().min(0).max(100000).optional().default(100),
    action: z.enum(AUTO_SEND_ACTIONS),
    // null / omitted condition = "match any" on that dimension.
    category: z.enum(CATEGORIES).nullish(),
    sender_domain: z
      .string()
      .trim()
      .max(253, 'sender_domain too long')
      .transform((s) => s.toLowerCase())
      .refine((s) => DOMAIN_RE.test(s), 'must be a bare domain (e.g. acme.com)')
      .nullish(),
    // Rule-level confidence floor in [0, 1]. The code-side hard 0.75 floor
    // still applies for auto_send regardless of this value.
    min_confidence: z.coerce.number().min(0).max(1).nullish(),
    // Time-of-day window (operator-local). Both required together.
    active_from: hhmm.nullish(),
    active_to: hhmm.nullish(),
    // Shadow window end as an ISO timestamp; the rule logs-only until then.
    shadow_until: z.string().datetime({ offset: true }).nullish(),
  })
  // Time window is all-or-nothing.
  .refine(
    (v) =>
      (v.active_from === null || v.active_from === undefined) ===
      (v.active_to === null || v.active_to === undefined),
    { path: ['active_to'], message: 'active_from and active_to must be set together' },
  )
  // A non-empty window can't have identical endpoints (would match nothing).
  .refine(
    (v) =>
      v.active_from === null ||
      v.active_from === undefined ||
      v.active_to === null ||
      v.active_to === undefined ||
      (v.active_from >= 0 &&
        v.active_from < MINUTES_IN_DAY &&
        v.active_to >= 0 &&
        v.active_to < MINUTES_IN_DAY &&
        v.active_from !== v.active_to),
    { path: ['active_to'], message: 'active_from and active_to must differ' },
  );

// PATCH — every field optional; same constraints when present. A separate
// schema (not .partial() on the refined create schema) because zod refinements
// don't compose cleanly through .partial(). Conditions accept explicit null to
// CLEAR a previously-set condition.
export const autoSendRuleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    priority: z.coerce.number().int().min(0).max(100000).optional(),
    action: z.enum(AUTO_SEND_ACTIONS).optional(),
    category: z.enum(CATEGORIES).nullish(),
    sender_domain: z
      .string()
      .trim()
      .max(253)
      .transform((s) => s.toLowerCase())
      .refine((s) => DOMAIN_RE.test(s), 'must be a bare domain (e.g. acme.com)')
      .nullish(),
    min_confidence: z.coerce.number().min(0).max(1).nullish(),
    active_from: hhmm.nullish(),
    active_to: hhmm.nullish(),
    shadow_until: z.string().datetime({ offset: true }).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

export type AutoSendRuleCreate = z.infer<typeof autoSendRuleCreateSchema>;
export type AutoSendRuleUpdate = z.infer<typeof autoSendRuleUpdateSchema>;
