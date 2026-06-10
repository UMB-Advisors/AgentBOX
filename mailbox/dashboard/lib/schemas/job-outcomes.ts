import { z } from 'zod';
import { JOB_OUTCOME_STATUSES } from '@/lib/job-outcomes/queries';

// MBOX-462 — emit contract for POST /api/internal/job-outcomes. The hermes-agent
// cron scheduler (and gbrain minion completion) POST one outcome per produced
// artifact. `profile` is the hermes profile (company); department_id is the CRM
// department the job already carries. business_id may be sent explicitly, else
// it's resolved from `profile` server-side.

export const jobOutcomeBodySchema = z
  .object({
    source: z.string().min(1).max(64), // 'hermes_cron' | 'gbrain_minion' | …
    external_job_id: z.string().max(256).nullish(),
    job_name: z.string().min(1).max(256),
    profile: z.string().max(256).nullish(),
    business_id: z.number().int().positive().nullish(),
    department_id: z.number().int().positive().nullish(),
    outcome_type: z.string().min(1).max(64).default('other'),
    status: z.enum(JOB_OUTCOME_STATUSES).default('success'),
    title: z.string().max(2000).default(''),
    summary: z.string().max(8000).default(''),
    artifact_ref: z.record(z.string(), z.unknown()).default({}),
    // ISO-8601; defaults to NOW() at the DB when omitted.
    occurred_at: z.string().datetime().nullish(),
  })
  .strict();

export type JobOutcomeBody = z.infer<typeof jobOutcomeBodySchema>;
