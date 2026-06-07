import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestPool, fakeRequest, getTestPool, HAS_DB } from '../helpers/db';

// STAQPRO-149: persona settings route tests. Default `customer_key='default'`
// is seeded by migration 006-create-onboarding-and-seed; tests assume that row
// exists and patch it back to a known empty state in afterAll.

const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('persona route handlers — real Postgres', () => {
  beforeAll(async () => {
    // CI bootstraps the schema from a pg_dump -s snapshot (no rows). Seed the
    // default persona row idempotently. Local dev DBs that already have the
    // row from migration 006 see a no-op upsert.
    // MBOX-352 (migration 036): persona uniqueness is now (account_id,
    // customer_key) — the global UNIQUE(customer_key) was dropped. account_id is
    // omitted here so its column DEFAULT (the seeded default account) fills it,
    // and the conflict target matches the new composite unique index.
    const pool = getTestPool();
    await pool.query(
      `INSERT INTO mailbox.persona
         (customer_key, statistical_markers, category_exemplars, source_email_count)
       VALUES ('default', '{}'::jsonb, '{}'::jsonb, 0)
       ON CONFLICT (account_id, customer_key) DO UPDATE
         SET statistical_markers = '{}'::jsonb,
             category_exemplars = '{}'::jsonb,
             updated_at = NOW()`,
    );
  });

  afterAll(async () => {
    const pool = getTestPool();
    await pool.query(
      `UPDATE mailbox.persona
         SET statistical_markers = '{}'::jsonb,
             category_exemplars = '{}'::jsonb
       WHERE customer_key = 'default'`,
    );
    await closeTestPool();
  });

  it('GET returns default persona row', async () => {
    const { GET } = await import('@/app/api/persona/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { persona: { customer_key: string } | null };
    expect(body.persona?.customer_key).toBe('default');
  });

  it('PUT validates the request body', async () => {
    const { PUT } = await import('@/app/api/persona/route');
    const res = await PUT(
      fakeRequest({ body: { statistical_markers: 'not an object', category_exemplars: {} } }),
    );
    expect(res.status).toBe(400);
  });

  it('PUT upserts persona JSON fields', async () => {
    const { PUT } = await import('@/app/api/persona/route');
    const stat = { tone: 'concise', avg_sentence_words: 14 };
    const exem = { reorder: { example: 'sample reply' } };
    const res = await PUT(
      fakeRequest({ body: { statistical_markers: stat, category_exemplars: exem } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      persona: { statistical_markers: typeof stat; category_exemplars: typeof exem };
    };
    expect(body.persona.statistical_markers).toEqual(stat);
    expect(body.persona.category_exemplars).toEqual(exem);

    // Verify it actually wrote to the DB
    const pool = getTestPool();
    const r = await pool.query<{
      statistical_markers: typeof stat;
      category_exemplars: typeof exem;
    }>(
      `SELECT statistical_markers, category_exemplars FROM mailbox.persona WHERE customer_key = 'default'`,
    );
    expect(r.rows[0].statistical_markers).toEqual(stat);
    expect(r.rows[0].category_exemplars).toEqual(exem);
  });

  // MBOX-373 (MBOX-162 V6 P1) — account-scoped voice learning.
  describe('POST /api/persona/refresh — account-scoped (MBOX-373)', () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    it("extracts a specific account's persona from ONLY its own sent_history", async () => {
      const pool = getTestPool();
      const acct = await pool.query<{ id: number }>(
        `INSERT INTO mailbox.accounts (email_address, display_label, is_default, provider)
         VALUES ($1, 'Founder', false, 'gmail') RETURNING id`,
        [`v6-${stamp}@example.test`],
      );
      const accountId = acct.rows[0].id;
      try {
        for (let i = 0; i < 3; i++) {
          await pool.query(
            `INSERT INTO mailbox.sent_history
               (from_addr, to_addr, subject, body_text, draft_sent, draft_source,
                classification_category, classification_confidence, sent_at, account_id)
             VALUES ($1, 'customer@example.com', 'Re: your order', 'inbound body',
                     $2, 'local', 'reorder', 0.9, NOW(), $3)`,
            [
              `v6-${stamp}@example.test`,
              'Hi there,\n\nThanks so much for reaching out — happy to help with your reorder. Best,\nDustin',
              accountId,
            ],
          );
        }

        const { POST } = await import('@/app/api/persona/refresh/route');
        const res = await POST(fakeRequest({ body: { account_id: accountId } }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { source_email_count: number };
        expect(body.source_email_count).toBe(3);

        // The new account's persona row was written...
        const p = await pool.query<{ source_email_count: number }>(
          `SELECT source_email_count FROM mailbox.persona WHERE account_id = $1 AND customer_key = 'default'`,
          [accountId],
        );
        expect(Number(p.rows[0].source_email_count)).toBe(3);

        // ...and the DEFAULT account's persona was left untouched (still the
        // empty row seeded in beforeAll — proves account isolation).
        const def = await pool.query<{ source_email_count: number; account_id: number }>(
          `SELECT source_email_count, account_id FROM mailbox.persona
             WHERE customer_key = 'default' AND account_id <> $1`,
          [accountId],
        );
        expect(Number(def.rows[0].source_email_count)).toBe(0);
      } finally {
        await pool.query('DELETE FROM mailbox.persona WHERE account_id = $1', [accountId]);
        await pool.query('DELETE FROM mailbox.sent_history WHERE account_id = $1', [accountId]);
        await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [accountId]);
      }
    });

    it('returns 409 for an account with no sent_history yet', async () => {
      const pool = getTestPool();
      const acct = await pool.query<{ id: number }>(
        `INSERT INTO mailbox.accounts (email_address, is_default, provider)
         VALUES ($1, false, 'imap') RETURNING id`,
        [`v6-empty-${stamp}@example.test`],
      );
      const accountId = acct.rows[0].id;
      try {
        const { POST } = await import('@/app/api/persona/refresh/route');
        const res = await POST(fakeRequest({ body: { account_id: accountId } }));
        expect(res.status).toBe(409);
        const body = (await res.json()) as { account_id: number };
        expect(body.account_id).toBe(accountId);
      } finally {
        await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [accountId]);
      }
    });

    it('rejects a non-positive account_id with 400', async () => {
      const { POST } = await import('@/app/api/persona/refresh/route');
      const res = await POST(fakeRequest({ body: { account_id: -1 } }));
      expect(res.status).toBe(400);
    });
  });
});
