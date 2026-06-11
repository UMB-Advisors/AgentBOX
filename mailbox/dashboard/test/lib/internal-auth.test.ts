// MBOX-482 — unit tests for the shared internal-route auth gate
// (lib/internal-auth.ts). Pure (no DB), so it runs in every harness.
//
// The load-bearing assertion: an EMPTY/whitespace HERMES_INTERNAL_TOKEN must
// REJECT — the pre-extraction copies fell back to a naive timingSafeEqual that
// an empty header would have matched (an open door). Also covers the unset env,
// a length mismatch (no length-leak early-exit), the over-length reject, and the
// happy path.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorized } from '@/lib/internal-auth';

// Minimal NextRequest stand-in: authorized() only reads the
// x-hermes-internal-token header, so a Headers-backed shim is sufficient.
function reqWithToken(token: string | null): import('next/server').NextRequest {
  const headers = new Headers();
  if (token !== null) headers.set('x-hermes-internal-token', token);
  return { headers } as unknown as import('next/server').NextRequest;
}

const REAL_TOKEN = 'a'.repeat(64); // 32-byte secret as 64 hex chars (the canonical shape)

describe('internal-auth authorized()', () => {
  const saved = process.env.HERMES_INTERNAL_TOKEN;
  beforeEach(() => {
    delete process.env.HERMES_INTERNAL_TOKEN;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.HERMES_INTERNAL_TOKEN;
    else process.env.HERMES_INTERNAL_TOKEN = saved;
  });

  it('rejects when HERMES_INTERNAL_TOKEN is unset', () => {
    expect(authorized(reqWithToken(REAL_TOKEN))).toBe(false);
  });

  it('rejects when HERMES_INTERNAL_TOKEN is an empty string (no open door)', () => {
    process.env.HERMES_INTERNAL_TOKEN = '';
    // Even when the caller presents an empty header, an empty env must NOT match.
    expect(authorized(reqWithToken(''))).toBe(false);
    expect(authorized(reqWithToken(REAL_TOKEN))).toBe(false);
  });

  it('rejects when HERMES_INTERNAL_TOKEN is whitespace-only', () => {
    process.env.HERMES_INTERNAL_TOKEN = '   ';
    expect(authorized(reqWithToken('   '))).toBe(false);
  });

  it('rejects a missing header against a real token', () => {
    process.env.HERMES_INTERNAL_TOKEN = REAL_TOKEN;
    expect(authorized(reqWithToken(null))).toBe(false);
  });

  it('rejects a wrong token of a different length (no length-leak early-exit)', () => {
    process.env.HERMES_INTERNAL_TOKEN = REAL_TOKEN;
    expect(authorized(reqWithToken('b'.repeat(10)))).toBe(false);
    expect(authorized(reqWithToken('b'.repeat(64)))).toBe(false);
  });

  it('rejects a presented token longer than the compare width (no truncation false-positive)', () => {
    process.env.HERMES_INTERNAL_TOKEN = REAL_TOKEN;
    // A 65th byte differing past the 64-byte width must NOT be truncated to a match.
    expect(authorized(reqWithToken(`${REAL_TOKEN}x`))).toBe(false);
  });

  it('rejects when the expected token exceeds the compare width', () => {
    process.env.HERMES_INTERNAL_TOKEN = 'c'.repeat(65);
    expect(authorized(reqWithToken('c'.repeat(65)))).toBe(false);
  });

  it('accepts a correct token', () => {
    process.env.HERMES_INTERNAL_TOKEN = REAL_TOKEN;
    expect(authorized(reqWithToken(REAL_TOKEN))).toBe(true);
  });
});
