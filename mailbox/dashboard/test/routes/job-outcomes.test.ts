import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/internal/job-outcomes/route';
import { closeTestPool, fakeRequest, getTestPool, HAS_DB } from '../helpers/db';

// MBOX-462 — the emit sink POST /api/internal/job-outcomes. DB-backed; skips
// without TEST_POSTGRES_URL. Cleans up its stamped rows.

const dbDescribe = HAS_DB ? describe : describe.skip;
const STAMP = 'mbox462route';

dbDescribe('POST /api/internal/job-outcomes — real Postgres', () => {
  afterEach(async () => {
    await getTestPool().query('DELETE FROM mailbox.job_outcomes WHERE job_name LIKE $1', [
      `${STAMP}%`,
    ]);
  });
  afterAll(async () => {
    await getTestPool().query('DELETE FROM mailbox.job_outcomes WHERE job_name LIKE $1', [
      `${STAMP}%`,
    ]);
    await closeTestPool();
  });

  it('records a valid outcome and returns 200 with the id', async () => {
    const res = await POST(
      fakeRequest({
        body: {
          source: 'hermes_cron',
          job_name: `${STAMP}-blog`,
          outcome_type: 'blog_post',
          status: 'success',
          title: 'A post',
          artifact_ref: { draft_id: 42 },
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(typeof json.id).toBe('string');

    const { rows } = await getTestPool().query(
      'SELECT outcome_type, artifact_ref FROM mailbox.job_outcomes WHERE id = $1',
      [json.id],
    );
    expect(rows[0].outcome_type).toBe('blog_post');
    expect(rows[0].artifact_ref).toEqual({ draft_id: 42 });
  });

  it('rejects a bad body (missing job_name) with 400', async () => {
    const res = await POST(fakeRequest({ body: { source: 'hermes_cron' } }));
    expect(res.status).toBe(400);
  });

  it('rejects an unknown status with 400', async () => {
    const res = await POST(
      fakeRequest({ body: { source: 'hermes_cron', job_name: `${STAMP}-x`, status: 'bogus' } }),
    );
    expect(res.status).toBe(400);
  });
});
