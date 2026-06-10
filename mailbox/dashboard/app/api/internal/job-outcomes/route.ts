import { type NextRequest, NextResponse } from 'next/server';
import { recordJobOutcome } from '@/lib/job-outcomes/queries';
import { parseJson } from '@/lib/middleware/validate';
import { jobOutcomeBodySchema } from '@/lib/schemas/job-outcomes';

export const dynamic = 'force-dynamic';

// POST /api/internal/job-outcomes — MBOX-462
//
// The sink for agent-job outcomes. v1 emitters:
//   - hermes-agent cron scheduler (cron/scheduler.py) — one POST per produced
//     artifact (draft, report, blog post) after a scheduled run delivers.
//   - gbrain minion completion — when a minion job finishes the work a cron job
//     dispatched (source='gbrain_minion'), carrying the same profile/department.
//
// The route records the outcome in mailbox.job_outcomes; business_id is resolved
// from `profile` when not sent explicitly. The Daily Brief then rolls these up
// per Business and Department (lib/queries-digest.ts:getDigestPayload).
//
// Internal (docker-network) route — not Caddy basic_auth gated; zod-validated
// aggressively per the internal-route contract. Bad body shape → 400 (caller
// bug). A DB failure → 500 (the emitter can retry); we do NOT swallow it,
// because a lost outcome is a silently-missing brief line.

export async function POST(req: NextRequest) {
  const parsed = await parseJson(req, jobOutcomeBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const outcome = await recordJobOutcome({
    source: body.source,
    external_job_id: body.external_job_id ?? null,
    job_name: body.job_name,
    profile: body.profile ?? null,
    business_id: body.business_id ?? null,
    department_id: body.department_id ?? null,
    outcome_type: body.outcome_type,
    status: body.status,
    title: body.title,
    summary: body.summary,
    artifact_ref: body.artifact_ref,
    occurred_at: body.occurred_at ?? null,
  });

  return NextResponse.json({
    ok: true,
    id: outcome.id,
    business_id: outcome.business_id,
    department_id: outcome.department_id,
  });
}
