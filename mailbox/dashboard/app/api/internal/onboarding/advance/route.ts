import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { isAllowedTransition } from '@/lib/onboarding/wizard-stages';
import { getOnboarding, setStage } from '@/lib/queries-onboarding';
import { onboardingAdvanceBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

// STAQPRO-152 — wizard step transition route. Strict adjacent-pair contract:
// the wizard sends { from, to, customer_key } where (from, to) MUST be one of
// ALLOWED_TRANSITIONS in lib/onboarding/wizard-stages.ts. Skip-aheads,
// backwards moves, and stale-from concurrency races all return 409.
//
// Internal-only: not Caddy basic_auth gated. The wizard pages call this from
// the customer's browser, so it IS publicly reachable through the dashboard
// routing — but the operation is bounded (one DB row UPDATE on a single
// non-secret enum column) and zod-validated (STAQPRO-138). HMAC gating is a
// planned hardening once the broader internal-route auth model lands.

interface AdvanceSuccess {
  ok: true;
  stage: string;
}

interface AdvanceError {
  error: 'invalid_transition' | 'stale_from' | 'no_onboarding_row' | 'internal_error';
  [key: string]: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseJson(request, onboardingAdvanceBodySchema);
  if (!parsed.ok) return parsed.response;

  const { from, to, customer_key } = parsed.data;

  try {
    const row = await getOnboarding(customer_key);
    if (!row) {
      return NextResponse.json<AdvanceError>(
        { error: 'no_onboarding_row', customer_key },
        { status: 404 },
      );
    }

    // Concurrency guard: the wizard's view of the current stage must match
    // the DB. If it doesn't, the wizard is stale (operator opened the
    // wizard, walked away, then clicked Next after another path advanced
    // the row). Better to surface than to silently re-overwrite.
    if (row.stage !== from) {
      return NextResponse.json<AdvanceError>(
        { error: 'stale_from', actual: row.stage, expected: from },
        { status: 409 },
      );
    }

    if (!isAllowedTransition(from, to)) {
      return NextResponse.json<AdvanceError>(
        { error: 'invalid_transition', from, to },
        { status: 409 },
      );
    }

    const updated = await setStage(to, customer_key);
    if (!updated) {
      // Vanishingly unlikely after the getOnboarding() above, but the row
      // could have been deleted between the SELECT and the UPDATE.
      return NextResponse.json<AdvanceError>(
        { error: 'no_onboarding_row', customer_key },
        { status: 404 },
      );
    }

    return NextResponse.json<AdvanceSuccess>({ ok: true, stage: updated.stage });
  } catch (error) {
    console.error('POST /api/internal/onboarding/advance failed:', error);
    return NextResponse.json<AdvanceError>(
      { error: 'internal_error', message: error instanceof Error ? error.message : 'unknown' },
      { status: 500 },
    );
  }
}
