import { z } from 'zod';
import { extractAddress } from '@/lib/classification/preclass';

// POST /api/classifications/reclassify-sender — MBOX-370 "reclassify automatically".
// Body shape: { email: string, reason?: string }.  NO category — this is the
// never-spam allowlist action, not a force-to-category rule (that was MBOX-368,
// reverted). The classifier re-runs and decides the real per-email category.
//
// `email` accepts either a bare address or a full "Name <addr>" header and is
// normalized through extractAddress() (the SAME helper the classify-time guard
// uses) so the value we store and the value the classifier looks up are
// byte-identical lowercased addresses. Anything without an `@` after extraction
// is rejected 400.
//
// `reason` is an optional free-text operator note (why this sender isn't spam).
const RECLASSIFY_REASON_MAX = 2000;

export const reclassifyBySenderBodySchema = z.object({
  email: z
    .string()
    .min(1, 'email required')
    .transform((s) => extractAddress(s))
    .pipe(z.string().min(3).regex(/.+@.+/, 'must be an email address')),
  reason: z
    .string()
    .trim()
    .max(RECLASSIFY_REASON_MAX, `reason must be <= ${RECLASSIFY_REASON_MAX} chars`)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export type ReclassifyBySenderBody = z.infer<typeof reclassifyBySenderBodySchema>;
