import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestPool, fakeRequest, getTestPool, HAS_DB } from '../helpers/db';

// STAQPRO-152 — onboarding wizard advance route. The route enforces the
// strict adjacent-pair contract from lib/onboarding/wizard-stages.ts'
// ALLOWED_TRANSITIONS. The schema-rejection test runs without HAS_DB because
// zod fails before any DB call; the four DB-touching cases skip when
// TEST_POSTGRES_URL is unset.

const dbDescribe = HAS_DB ? describe : describe.skip;

async function setStageDirect(stage: string, customerKey = 'default'): Promise<void> {
  // Upsert because the test fixture schema.sql is structure-only; the
  // production seed (migration 006) is not replayed in CI.
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO mailbox.onboarding (customer_key, stage)
     VALUES ($2, $1)
     ON CONFLICT (customer_key) DO UPDATE SET stage = EXCLUDED.stage`,
    [stage, customerKey],
  );
}

async function readStageDirect(customerKey = 'default'): Promise<string | null> {
  const pool = getTestPool();
  const r = await pool.query<{ stage: string }>(
    'SELECT stage FROM mailbox.onboarding WHERE customer_key = $1',
    [customerKey],
  );
  return r.rows[0]?.stage ?? null;
}

describe('POST /api/internal/onboarding/advance — schema validation (no DB)', () => {
  it('rejects an unknown `from` value with 400 validation_failed', async () => {
    const { POST } = await import('@/app/api/internal/onboarding/advance/route');
    const res = await POST(
      fakeRequest({ body: { from: 'not_a_stage', to: 'live', customer_key: 'default' } }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('validation_failed');
  });
});

dbDescribe('POST /api/internal/onboarding/advance — DB-backed', () => {
  beforeEach(async () => {
    // Reset to the seed stage before every case.
    await setStageDirect('pending_admin');
  });

  afterEach(async () => {
    await setStageDirect('pending_admin');
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('happy path: pending_admin → pending_email returns 200 + persists', async () => {
    const { POST } = await import('@/app/api/internal/onboarding/advance/route');
    const res = await POST(
      fakeRequest({
        body: { from: 'pending_admin', to: 'pending_email', customer_key: 'default' },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, stage: 'pending_email' });
    expect(await readStageDirect()).toBe('pending_email');
  });

  it('rejects skip-ahead pending_admin → live with 409 invalid_transition', async () => {
    const { POST } = await import('@/app/api/internal/onboarding/advance/route');
    const res = await POST(
      fakeRequest({ body: { from: 'pending_admin', to: 'live', customer_key: 'default' } }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('invalid_transition');
    expect(json.from).toBe('pending_admin');
    expect(json.to).toBe('live');
    expect(await readStageDirect()).toBe('pending_admin');
  });

  it('rejects backwards pending_email → pending_admin with 409 invalid_transition', async () => {
    await setStageDirect('pending_email');
    const { POST } = await import('@/app/api/internal/onboarding/advance/route');
    const res = await POST(
      fakeRequest({
        body: { from: 'pending_email', to: 'pending_admin', customer_key: 'default' },
      }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('invalid_transition');
    expect(await readStageDirect()).toBe('pending_email');
  });

  it('rejects stale `from` (DB ahead of wizard view) with 409 stale_from', async () => {
    await setStageDirect('pending_email');
    const { POST } = await import('@/app/api/internal/onboarding/advance/route');
    const res = await POST(
      fakeRequest({
        body: { from: 'pending_admin', to: 'pending_email', customer_key: 'default' },
      }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('stale_from');
    expect(json.actual).toBe('pending_email');
    expect(json.expected).toBe('pending_admin');
    expect(await readStageDirect()).toBe('pending_email');
  });
});
