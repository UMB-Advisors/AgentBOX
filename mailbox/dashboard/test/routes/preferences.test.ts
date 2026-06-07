import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, fakeRequest, getTestPool, HAS_DB } from '../helpers/db';

// MBOX-133: operator filter/sort preference persistence route tests.
// GET/PUT /api/operator/preferences/[key]. Single-operator world — rows are
// keyed by `key` with operator_id IS NULL (partial unique index from
// migration 026). Each test uses a unique key namespace so parallel runs and
// re-runs don't collide; afterAll cleans up the test keys.

const TEST_KEYS = ['queue.filters', 'queue.sort'] as const;

const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('operator preferences route handlers — real Postgres', () => {
  afterAll(async () => {
    const pool = getTestPool();
    await pool.query(
      `DELETE FROM mailbox.user_filter_preferences
        WHERE operator_id IS NULL AND key = ANY($1)`,
      [[...TEST_KEYS]],
    );
    await closeTestPool();
  });

  it('GET returns 404 when no preference is persisted', async () => {
    const { GET } = await import('@/app/api/operator/preferences/[key]/route');
    const res = await GET(fakeRequest(), { params: { key: 'queue.filters' } });
    expect(res.status).toBe(404);
  });

  it('PUT then GET round-trips the value (survives a reload)', async () => {
    const { PUT, GET } = await import('@/app/api/operator/preferences/[key]/route');
    const value = {
      categories: ['reorder', 'scheduling'],
      statuses: ['pending'],
      routes: [],
      confidence_bands: ['low'],
      age_bands: [],
    };

    const putRes = await PUT(fakeRequest({ body: { value } }), {
      params: { key: 'queue.filters' },
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { key: string; value: typeof value };
    expect(putBody.key).toBe('queue.filters');
    expect(putBody.value).toEqual(value);

    const getRes = await GET(fakeRequest(), { params: { key: 'queue.filters' } });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { key: string; value: typeof value };
    expect(getBody.value).toEqual(value);

    // Verify it actually wrote to the DB (single-operator row).
    const pool = getTestPool();
    const r = await pool.query<{ value: typeof value }>(
      `SELECT value FROM mailbox.user_filter_preferences
        WHERE key = 'queue.filters' AND operator_id IS NULL`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].value).toEqual(value);
  });

  it('PUT upserts in place — second write replaces, no duplicate row', async () => {
    const { PUT } = await import('@/app/api/operator/preferences/[key]/route');

    await PUT(fakeRequest({ body: { value: { mode: 'newest' } } }), {
      params: { key: 'queue.sort' },
    });
    const second = await PUT(fakeRequest({ body: { value: { mode: 'urgency' } } }), {
      params: { key: 'queue.sort' },
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { value: { mode: string } };
    expect(body.value.mode).toBe('urgency');

    const pool = getTestPool();
    const r = await pool.query(
      `SELECT id FROM mailbox.user_filter_preferences
        WHERE key = 'queue.sort' AND operator_id IS NULL`,
    );
    expect(r.rows).toHaveLength(1);
  });

  it('PUT rejects a malformed key param (zod 400)', async () => {
    const { PUT } = await import('@/app/api/operator/preferences/[key]/route');
    const res = await PUT(fakeRequest({ body: { value: { x: 1 } } }), {
      params: { key: 'Queue Filters!' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_failed');
  });

  it('PUT rejects a non-object/array value (zod 400)', async () => {
    const { PUT } = await import('@/app/api/operator/preferences/[key]/route');
    const res = await PUT(fakeRequest({ body: { value: 'not-an-object' } }), {
      params: { key: 'queue.filters' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_failed');
  });

  it('PUT rejects a missing value field (zod 400)', async () => {
    const { PUT } = await import('@/app/api/operator/preferences/[key]/route');
    const res = await PUT(fakeRequest({ body: {} }), {
      params: { key: 'queue.filters' },
    });
    expect(res.status).toBe(400);
  });
});
