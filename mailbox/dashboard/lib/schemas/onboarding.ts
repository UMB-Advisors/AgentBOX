import { z } from 'zod';

// STAQPRO-193 — onboarding backfill request schema. Used by
// /api/onboarding/backfill (the wizard hook per Locked Decision #3 — the
// CLI is canonical, but the route is left in place so 02-08's wizard
// promotion is one call rather than a fork).

export const onboardingBackfillRequestSchema = z.object({
  days_lookback: z
    .number()
    .int()
    .positive()
    .max(3650, 'days_lookback capped at 3650 days (~10 years)')
    .default(180),
  max_messages: z.number().int().positive().max(100000, 'max_messages capped at 100000').optional(),
});

export type OnboardingBackfillRequest = z.infer<typeof onboardingBackfillRequestSchema>;
