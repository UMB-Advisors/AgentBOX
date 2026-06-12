import { timingSafeEqual } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';

// Defensive shared-secret gate for onboarding mutation routes.
//
// If ONBOARDING_API_TOKEN is set in the environment, every POST to an
// onboarding route must supply the matching value in the `x-onboarding-token`
// header. Mismatch or missing header → 401 JSON { error: 'unauthorized' }.
//
// If ONBOARDING_API_TOKEN is NOT set, this function returns null (allow) and
// the routes behave exactly as before — boxes opt in at provision time.
//
// Thread the token to client fetches via a server-side prop (read
// process.env.ONBOARDING_API_TOKEN in a server component and pass it as a
// prop). Do NOT use NEXT_PUBLIC_* — that bakes the secret into the client
// bundle.
//
// NOTE (2026-06-11): the onboarding wizard pages (StepNav, ImapConnectForm,
// GraphConnectForm) are 'use client' components with no server component
// parent that can thread props. Until those components are refactored to
// accept the token from a server wrapper, ONBOARDING_API_TOKEN must remain
// unset (or the Caddy basic_auth gate is the operative protection). See the
// exposure analysis in the first commit on fix/onboarding-route-auth.
export function requireOnboardingToken(req: NextRequest): NextResponse | null {
  const secret = process.env.ONBOARDING_API_TOKEN;
  if (!secret) {
    // Env var not set — back-compat allow.
    return null;
  }

  const provided = req.headers.get('x-onboarding-token') ?? '';

  // Use constant-time comparison to prevent timing attacks. Both buffers must
  // be the same byte length; pad/reject unequal lengths without short-circuit.
  const secretBuf = Buffer.from(secret, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');

  let match: boolean;
  if (secretBuf.length !== providedBuf.length) {
    // Lengths differ — run a dummy same-length comparison so the branch
    // timing is indistinguishable from a same-length mismatch, then reject.
    const dummy = Buffer.alloc(secretBuf.length);
    try {
      timingSafeEqual(secretBuf, dummy);
    } catch {
      // Unreachable: both buffers have the same length by construction.
    }
    match = false;
  } else {
    match = timingSafeEqual(secretBuf, providedBuf);
  }

  if (!match) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  return null;
}
