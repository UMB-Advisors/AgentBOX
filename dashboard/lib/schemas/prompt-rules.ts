import { z } from 'zod';
import { PROMPT_RULE_SCOPES } from '@/lib/types';

// MBOX-162 P5b — validation for the prompt_rules CRUD surface
// (POST /api/prompt-rules, PATCH/DELETE /api/prompt-rules/[id]). The DB also
// CHECKs scope ∈ PROMPT_RULE_SCOPES and rule non-blank (migration 044).

export const promptRuleCreateSchema = z.object({
  scope: z.enum(PROMPT_RULE_SCOPES),
  rule: z.string().trim().min(1, 'rule is required').max(1000, 'rule too long'),
  // Optional "why". Defaults to '' so the row stores a clean empty string.
  rationale: z.string().trim().max(1000, 'rationale too long').default(''),
});

// PATCH body — every field optional, but at least one must be present so an
// empty PATCH is rejected rather than silently bumping updated_at.
export const promptRuleUpdateSchema = z
  .object({
    scope: z.enum(PROMPT_RULE_SCOPES).optional(),
    rule: z.string().trim().min(1, 'rule cannot be blank').max(1000, 'rule too long').optional(),
    rationale: z.string().trim().max(1000, 'rationale too long').optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

export const promptRuleIdParamSchema = z.object({
  id: z.coerce.number().int().positive('id must be a positive integer'),
});

export type PromptRuleCreate = z.infer<typeof promptRuleCreateSchema>;
export type PromptRuleUpdate = z.infer<typeof promptRuleUpdateSchema>;
export type PromptRuleIdParam = z.infer<typeof promptRuleIdParamSchema>;
