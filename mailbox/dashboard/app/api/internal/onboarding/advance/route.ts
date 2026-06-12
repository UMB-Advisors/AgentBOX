import { type NextRequest, NextResponse } from 'next/server';
import { requireOnboardingToken } from '@/lib/middleware/onboarding-auth';
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
// Internal-only: protected by a shared-secret gate (lib/middleware/onboarding-auth.ts)
// when ONBOARDING_API_TOKEN is set. If the env var is unset the gate is a no-op
// so existing installs are unaffected. The operative protection on correctly-configured
// boxes is Caddy basic_auth (see exposure analysis in fix/onboarding-route-auth commit 1).
// The client-side wizard components (StepNav, ImapConnectForm, GraphConnectForm) are all
// 'use client' with no server parent to thread the header through; ONBOARDING_API_TOKEN
// must remain unset until those components are refactored. See onboarding-auth.ts for
// the full note on the client-threading gap.

interface AdvanceSuccess {
  ok: true;
  stage: string;
}

interface AdvanceError {
  error: 'invalid_transition' | 'stale_from' | 'no_onboarding_row' | 'internal_error';
  [key: string]: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authError = requireOnboardingToken(request);
  if (authError) return authError;

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
