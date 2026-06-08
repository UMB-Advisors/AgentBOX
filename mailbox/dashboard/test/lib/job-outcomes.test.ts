import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  getOutcomesRollup,
  recordJobOutcome,
  resolveBusinessIdByProfile,
} from '@/lib/job-outcomes/queries';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// MBOX-462 — job_outcomes ledger + per-Business/Department rollup against a real
// Postgres (the fixture-loaded CI pg). Skips without TEST_POSTGRES_URL like the
// other DB suites. Stamps its own CRM rows + outcomes and cleans them up.

const dbDescribe = HAS_DB ? describe : describe.skip;
const STAMP = 'mbox462test';

dbDescribe('job_outcomes ledger + rollup — real Postgres', () => {
  let bizYes: number;
  let bizState: number;
  let deptMkt: number;
  let deptSales: number;

  beforeAll(async () => {
    const pool = getTestPool();
    // Two businesses + departments to group under.
    const b1 = await pool.query<{ id: number }>(
      'INSERT INTO mailbox.businesses (name) VALUES ($1) RETURNING id',
      [`${STAMP} Yes Cacao`],
    );
    bizYes = b1.rows[0].id;
    const b2 = await pool.query<{ id: number }>(
      'INSERT INTO mailbox.businesses (name) VALUES ($1) RETURNING id',
      [`${STAMP} STATE`],
    );
    bizState = b2.rows[0].id;
    const d1 = await pool.query<{ id: number }>(
      'INSERT INTO mailbox.departments (name, business_id) VALUES ($1, $2) RETURNING id',
      [`${STAMP} Marketing`, bizYes],
    );
    deptMkt = d1.rows[0].id;
    const d2 = await pool.query<{ id: number }>(
      'INSERT INTO mailbox.departments (name, business_id) VALUES ($1, $2) RETURNING id',
      [`${STAMP} Sales`, bizState],
    );
    deptSales = d2.rows[0].id;
  });

  afterEach(async () => {
    await getTestPool().query('DELETE FROM mailbox.job_outcomes WHERE job_name LIKE $1', [
      `${STAMP}%`,
    ]);
  });

  afterAll(async () => {
    const pool = getTestPool();
    await pool.query('DELETE FROM mailbox.job_outcomes WHERE job_name LIKE $1', [`${STAMP}%`]);
    await pool.query('DELETE FROM mailbox.departments WHERE name LIKE $1', [`${STAMP}%`]);
    await pool.query('DELETE FROM mailbox.businesses WHERE name LIKE $1', [`${STAMP}%`]);
    await closeTestPool();
  });

  it('records an outcome and reads it back with defaults applied', async () => {
    const o = await recordJobOutcome({
      source: 'hermes_cron',
      job_name: `${STAMP}-blog`,
      business_id: bizYes,
      department_id: deptMkt,
      outcome_type: 'blog_post',
      title: 'Hello',
    });
    expect(o.business_id).toBe(bizYes);
    expect(o.department_id).toBe(deptMkt);
    expect(o.status).toBe('success'); // default
    expect(o.artifact_ref).toEqual({}); // default
    expect(typeof o.id).toBe('string'); // BIGSERIAL
  });

  it('resolves business_id from a fuzzy profile name', async () => {
    // 'yes-cacao' → business 'mbox462test Yes Cacao'? No — normalize compares
    // the WHOLE name. Use the exact stamped name's normalized form.
    expect(await resolveBusinessIdByProfile(`${STAMP} yes cacao`)).toBe(bizYes);
    expect(await resolveBusinessIdByProfile(`${STAMP}-STATE`)).toBe(bizState);
    expect(await resolveBusinessIdByProfile('no-such-company-xyz')).toBeNull();
  });

  it('records via profile when business_id is omitted', async () => {
    const o = await recordJobOutcome({
      source: 'gbrain_minion',
      job_name: `${STAMP}-report`,
      profile: `${STAMP} STATE`,
      department_id: deptSales,
      outcome_type: 'report',
    });
    expect(o.business_id).toBe(bizState); // resolved from profile
  });

  it('rolls up per business then per department with counts, by_type and recent', async () => {
    await recordJobOutcome({
      source: 'hermes_cron',
      job_name: `${STAMP}-b1`,
      business_id: bizYes,
      department_id: deptMkt,
      outcome_type: 'blog_post',
      status: 'success',
      title: 'Post A',
    });
    await recordJobOutcome({
      source: 'hermes_cron',
      job_name: `${STAMP}-b2`,
      business_id: bizYes,
      department_id: deptMkt,
      outcome_type: 'blog_post',
      status: 'failed',
      title: 'Post B',
    });
    await recordJobOutcome({
      source: 'gbrain_minion',
      job_name: `${STAMP}-s1`,
      business_id: bizState,
      department_id: deptSales,
      outcome_type: 'report',
      status: 'success',
    });
    // An unassigned outcome (no business/department) folds into 'Unassigned'.
    await recordJobOutcome({
      source: 'hermes_cron',
      job_name: `${STAMP}-u1`,
      outcome_type: 'other',
    });

    const rollup = await getOutcomesRollup({ sinceHours: 24 });
    // Filter to this suite's rows (the shared DB may hold others).
    const mine = rollup.businesses.filter(
      (b) =>
        b.business_id === bizYes ||
        b.business_id === bizState ||
        (b.business_id === null &&
          b.departments.some((d) => d.recent.some((r) => r.job_name.startsWith(STAMP)))),
    );

    const yes = mine.find((b) => b.business_id === bizYes);
    expect(yes?.counts.total).toBe(2);
    const mkt = yes?.departments.find((d) => d.department_id === deptMkt);
    expect(mkt?.counts).toMatchObject({ total: 2, success: 1, failed: 1 });
    expect(mkt?.by_type).toEqual({ blog_post: 2 });
    expect(mkt?.recent.length).toBe(2);

    const unassigned = mine.find((b) => b.business_id === null);
    expect(unassigned?.business_name).toBe('Unassigned');
    expect(unassigned?.departments[0]?.department_name).toBe('Unassigned');
  });

  it('excludes outcomes outside the sinceHours window', async () => {
    const pool = getTestPool();
    await pool.query(
      `INSERT INTO mailbox.job_outcomes (source, job_name, business_id, occurred_at)
       VALUES ('hermes_cron', $1, $2, NOW() - INTERVAL '48 hours')`,
      [`${STAMP}-old`, bizYes],
    );
    const rollup = await getOutcomesRollup({ sinceHours: 24 });
    const yes = rollup.businesses.find((b) => b.business_id === bizYes);
    // The 48h-old row is the only one this test inserted → business absent.
    expect(yes).toBeUndefined();
  });
});
