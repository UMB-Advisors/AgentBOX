import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HAS_DB } from '../helpers/db';

// STAQPRO-193 — POST /api/onboarding/backfill (the wizard hook). DB-free
// validation tests; the end-to-end flow lives in
// test/lib/gmail-history-backfill-smoke.test.ts which gates on TEST_POSTGRES_URL.
// The 502 case acquires a Postgres advisory lock as its first action
// (concurrency guard) so it gates on HAS_DB; the validation cases short-
// circuit before reaching the lock so they run without a DB.

function fakeReq(body: unknown): Request {
  return new Request('http://test.local/api/onboarding/backfill', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/onboarding/backfill — STAQPRO-193', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('returns 500 misconfigured when MAILBOX_OPERATOR_EMAIL is unset', async () => {
    delete process.env.MAILBOX_OPERATOR_EMAIL;
    const { POST } = await import('@/app/api/onboarding/backfill/route');
    const res = await POST(fakeReq({ days_lookback: 30 }) as never);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('misconfigured');
  });

  it('returns 400 on bad input (negative days_lookback)', async () => {
    process.env.MAILBOX_OPERATOR_EMAIL = 'op@example.com';
    const { POST } = await import('@/app/api/onboarding/backfill/route');
    const res = await POST(fakeReq({ days_lookback: -7 }) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('validation_failed');
  });

  it.skipIf(!HAS_DB)(
    'accepts a valid request and surfaces 502 when n8n returns a non-retryable 4xx',
    async () => {
      process.env.MAILBOX_OPERATOR_EMAIL = 'op@example.com';
      process.env.MAILBOX_FETCH_HISTORY_URL = 'http://127.0.0.1:1/webhook/mailbox-fetch-history';
      // 404 is non-retry per gmail-history-backfill.ts callFetchHistory — the
      // route should map the thrown failure to a 502, not a 500.
      globalThis.fetch = vi.fn(
        async () => new Response('not found', { status: 404 }),
      ) as unknown as typeof fetch;
      const { POST } = await import('@/app/api/onboarding/backfill/route');
      const res = await POST(fakeReq({ days_lookback: 30 }) as never);
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.error).toBe('backfill_failed');
      expect(json.message).toMatch(/non-retry/);
    },
  );
});
