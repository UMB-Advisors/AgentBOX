// dashboard/lib/internal-auth.ts
//
// MBOX-482 — single shared constant-time gate for the /api/internal/* routes
// Hermes calls over the docker network with X-Hermes-Internal-Token. Extracted
// from the four MBOX-482 route handlers (accounts/register, accounts/deregister,
// graph/access-token, imap-credentials) that had copy-pasted this check, so the
// security posture lives in ONE place.
//
// Two defects the per-route copies had, fixed here:
//   (a) length-early-exit (`if (a.length !== b.length) return false`) before the
//       timingSafeEqual leaked the expected token's LENGTH via response timing.
//       This compares fixed-width 64-byte zero-padded buffers so the comparison
//       is constant-time regardless of the presented or expected token length.
//   (b) an EMPTY/whitespace HERMES_INTERNAL_TOKEN ('' set explicitly) made the
//       per-route `if (!expected) return false` pass for a '' env but, worse, a
//       naive timingSafeEqual(empty, empty) would have matched an empty header —
//       an open door. We reject unset OR empty/whitespace-only tokens up front.
//
// Fail-closed: a box provisioned without a real HERMES_INTERNAL_TOKEN rejects
// EVERY internal request rather than projecting/minting unauthenticated.

import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

// Fixed comparison width. A 32-byte secret (e.g. `openssl rand -hex 32` → 64 hex
// chars) fits comfortably; both sides are zero-padded to this width so the
// timingSafeEqual buffers are always equal-length (its hard requirement) without
// a length early-exit. Tokens longer than this are rejected outright (see below)
// rather than truncated — truncation to a fixed width could let a > WIDTH token
// that shares its first WIDTH bytes with the secret produce a false positive.
const COMPARE_WIDTH = 64;

// Pad (or reject) a token to exactly COMPARE_WIDTH bytes. Returns null when the
// token is longer than COMPARE_WIDTH so the caller fails closed — never silently
// truncate, which would collapse distinct tokens onto the same prefix.
function fixedWidth(token: string): Buffer | null {
  const raw = Buffer.from(token, 'utf8');
  if (raw.length > COMPARE_WIDTH) return null;
  const buf = Buffer.alloc(COMPARE_WIDTH); // zero-filled
  raw.copy(buf);
  return buf;
}

// Constant-time shared-secret check for the internal routes. Returns false when:
//   - HERMES_INTERNAL_TOKEN is unset, empty, or whitespace-only (fail closed)
//   - the presented or expected token exceeds COMPARE_WIDTH bytes
//   - the tokens differ
// The comparison itself runs over fixed-width buffers with no length-dependent
// early exit, so it leaks neither the expected token's length nor its content.
export function authorized(req: NextRequest): boolean {
  const expectedRaw = process.env.HERMES_INTERNAL_TOKEN;
  // Reject unset OR empty/whitespace-only — '' must NOT open the door.
  if (!expectedRaw || expectedRaw.trim() === '') return false;

  const presentedRaw = req.headers.get('x-hermes-internal-token') ?? '';

  const expected = fixedWidth(expectedRaw);
  const presented = fixedWidth(presentedRaw);
  // A token longer than COMPARE_WIDTH (either side) fails closed. A null expected
  // can't be compared at all, so bail. When only the presented token is
  // over-length, run a same-width comparison against expected first so the reject
  // path's timing matches the ordinary mismatch path, then reject.
  if (expected === null) return false;
  if (presented === null) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(presented, expected);
}
