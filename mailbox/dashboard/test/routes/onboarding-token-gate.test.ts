import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// Tests for the shared-secret gate added in fix/onboarding-route-auth.
// Covers lib/middleware/onboarding-auth.ts via the advance route (the same
// guard is wired identically in imap-connect and graph-connect).
//
// Three behaviours under test:
//   1. ONBOARDING_API_TOKEN set + wrong/missing header → 401, DB untouched.
//   2. ONBOARDING_API_TOKEN set + correct header → passes through to handler.
//   3. ONBOARDING_API_TOKEN unset → passes through (back-compat, no gate).

const dbDescribe = HAS_DB ? describe : describe.skip;

// fakeRequest that also supports headers (the shared helper only supports body/url).
function fakeRequestWithHeaders(opts: {
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): import('next/server').NextRequest {
  const url = opts.url ?? 'http://test.local/api';
  const hdrs = new Headers(opts.headers ?? {});
  return {
    url,
    headers: hdrs,
    json: async () => {
      if (opts.body === undefined) throw new Error('no body');
      return opts.body;
    },
  } as unknown as import('next/server').NextRequest;
}

// Minimal valid advance body so the handler can reach the DB check.
const VALID_BODY = { from: 'pending_admin', to: 'pending_email', customer_key: 'default' };

// ─── Token-gate tests (no DB needed for the 401 cases) ───────────────────────

describe('onboarding token gate — ONBOARDING_API_TOKEN set', () => {
  beforeEach(() => {
    vi.stubEnv('ONBOARDING_API_TOKEN', 'test-secret-abc');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // Bust the module cache so the next import re-reads process.env.
    vi.resetModules();
  });

  it('returns 401 when x-onboarding-token header is missing', async () => {
    const { POST } = await import('@/app/api/internal/onboarding/advance/route');
    const res = await POST(fakeRequestWithHeaders({ body: VALID_BODY }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 when x-onboarding-token header is wrong', async () => {
    const { POST } = await import('@/app/api/internal/onboarding/advance/route');
    const res = await POST(
      fakeRequestWithHeaders({
        body: VALID_BODY,
        headers: { 'x-onboarding-token': 'wrong-value' },
      }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: 'unauthorized' });
  });
});

// ─── Back-compat: env var unset → gate is a no-op ────────────────────────────

describe('onboarding token gate — ONBOARDING_API_TOKEN unset', () => {
  beforeEach(() => {
    // Ensure the var is absent (it may not be set in CI, but be explicit).
    vi.stubEnv('ONBOARDING_API_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('passes through to the handler when env var is unset (back-compat)', async () => {
    const { POST } = await import('@/app/api/internal/onboarding/advance/route');
    // No DB → the handler will fail at getOnboarding(), but we get past the gate.
    // We only assert that the status is NOT 401.
    const res = await POST(fakeRequestWithHeaders({ body: VALID_BODY }));
    expect(res.status).not.toBe(401);
  });
});

// ─── Correct token + DB: happy path end-to-end ───────────────────────────────

dbDescribe('onboarding token gate — correct token passes through to handler', () => {
  beforeEach(async () => {
    vi.stubEnv('ONBOARDING_API_TOKEN', 'test-secret-abc');
    // Seed the onboarding row so the handler can succeed.
    const pool = getTestPool();
    await pool.query(
      `INSERT INTO mailbox.onboarding (customer_key, stage)
       VALUES ('default', 'pending_admin')
       ON CONFLICT (customer_key) DO UPDATE SET stage = EXCLUDED.stage`,
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    const pool = getTestPool();
    await pool.query(
      `INSERT INTO mailbox.onboarding (customer_key, stage)
       VALUES ('default', 'pending_admin')
       ON CONFLICT (customer_key) DO UPDATE SET stage = EXCLUDED.stage`,
    );
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('correct token → 200 and stage advances', async () => {
    const { POST } = await import('@/app/api/internal/onboarding/advance/route');
    const res = await POST(
      fakeRequestWithHeaders({
        body: VALID_BODY,
        headers: { 'x-onboarding-token': 'test-secret-abc' },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, stage: 'pending_email' });
  });
});
