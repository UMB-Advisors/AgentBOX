import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestPool, fakeRequest, getTestPool, HAS_DB } from '../helpers/db';

// MBOX-162 P5b — prompt_rules CRUD route tests against real Postgres. Covers the
// create → list → patch (version-bump vs enabled-toggle) → delete lifecycle and
// the 404 path. account_id is filled by getDefaultAccountId() (the fixture seeds
// the default account via migration 033). Cleans up its own rows in afterAll.

const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('prompt-rules route handlers — real Postgres', () => {
  beforeAll(async () => {
    await getTestPool().query(`DELETE FROM mailbox.prompt_rules`);
  });

  afterAll(async () => {
    await getTestPool().query(`DELETE FROM mailbox.prompt_rules`);
    await closeTestPool();
  });

  it('POST validates the body (bad scope → 400)', async () => {
    const { POST } = await import('@/app/api/prompt-rules/route');
    const res = await POST(fakeRequest({ body: { scope: 'sometimes', rule: 'x' } }));
    expect(res.status).toBe(400);
  });

  it('POST rejects a blank rule', async () => {
    const { POST } = await import('@/app/api/prompt-rules/route');
    const res = await POST(fakeRequest({ body: { scope: 'never', rule: '   ' } }));
    expect(res.status).toBe(400);
  });

  it('full lifecycle: create → list → patch → toggle → delete', async () => {
    const { POST, GET } = await import('@/app/api/prompt-rules/route');
    const idRoute = await import('@/app/api/prompt-rules/[id]/route');

    // Create — version 1, enabled, rationale defaults to ''.
    const created = await POST(fakeRequest({ body: { scope: 'never', rule: 'quote a price' } }));
    expect(created.status).toBe(200);
    const { rule } = (await created.json()) as {
      rule: { id: number; scope: string; version: number; enabled: boolean; rationale: string };
    };
    expect(rule.scope).toBe('never');
    expect(rule.version).toBe(1);
    expect(rule.enabled).toBe(true);
    expect(rule.rationale).toBe('');

    // List — surfaces the new rule.
    const listed = await GET(fakeRequest({}));
    const { rules } = (await listed.json()) as { rules: { id: number }[] };
    expect(rules.some((r) => r.id === rule.id)).toBe(true);

    // Content edit — bumps version.
    const edited = await idRoute.PATCH(fakeRequest({ body: { rule: 'quote a firm price' } }), {
      params: { id: String(rule.id) },
    });
    expect(edited.status).toBe(200);
    const editedBody = (await edited.json()) as { rule: { version: number; rule: string } };
    expect(editedBody.rule.version).toBe(2);
    expect(editedBody.rule.rule).toBe('quote a firm price');

    // Enabled toggle — does NOT bump version.
    const toggled = await idRoute.PATCH(fakeRequest({ body: { enabled: false } }), {
      params: { id: String(rule.id) },
    });
    const toggledBody = (await toggled.json()) as { rule: { version: number; enabled: boolean } };
    expect(toggledBody.rule.version).toBe(2);
    expect(toggledBody.rule.enabled).toBe(false);

    // Disabled rule is excluded from the draft-time enabled list.
    const { listEnabledPromptRules } = await import('@/lib/queries-prompt-rules');
    const enabled = await listEnabledPromptRules();
    expect(enabled.some((r) => r.id === rule.id)).toBe(false);

    // Delete — 200, then a second delete is 404.
    const del = await idRoute.DELETE(fakeRequest({}), { params: { id: String(rule.id) } });
    expect(del.status).toBe(200);
    const del2 = await idRoute.DELETE(fakeRequest({}), { params: { id: String(rule.id) } });
    expect(del2.status).toBe(404);
  });

  it('PATCH with an empty body → 400 (no fields to update)', async () => {
    const idRoute = await import('@/app/api/prompt-rules/[id]/route');
    const res = await idRoute.PATCH(fakeRequest({ body: {} }), { params: { id: '999999' } });
    expect(res.status).toBe(400);
  });

  it('PATCH a missing id → 404', async () => {
    const idRoute = await import('@/app/api/prompt-rules/[id]/route');
    const res = await idRoute.PATCH(fakeRequest({ body: { enabled: true } }), {
      params: { id: '999999' },
    });
    expect(res.status).toBe(404);
  });

  // MBOX-374 — per-account scoping: a rule created on inbox B must be invisible
  // to inbox A's reads, and A can't edit B's rule (the WHERE account_id guard).
  it('scopes rules per account via ?account=<id> (read + write isolation)', async () => {
    const { POST, GET } = await import('@/app/api/prompt-rules/route');
    const idRoute = await import('@/app/api/prompt-rules/[id]/route');
    const pool = getTestPool();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO mailbox.accounts (email_address) VALUES ('acct2-tuning-test@example.com') RETURNING id`,
    );
    const acct2 = rows[0].id;
    const acctUrl = `http://test.local/api?account=${acct2}`;
    try {
      const created = await POST(
        fakeRequest({ url: acctUrl, body: { scope: 'always', rule: 'acct2 only rule' } }),
      );
      expect(created.status).toBe(200);
      const { rule } = (await created.json()) as { rule: { id: number } };

      // Default-account read must NOT see acct2's rule.
      const defList = (await (await GET(fakeRequest({}))).json()) as { rules: { id: number }[] };
      expect(defList.rules.some((r) => r.id === rule.id)).toBe(false);

      // acct2 read sees it.
      const a2List = (await (await GET(fakeRequest({ url: acctUrl }))).json()) as {
        rules: { id: number }[];
      };
      expect(a2List.rules.some((r) => r.id === rule.id)).toBe(true);

      // Cross-account write (default account editing acct2's rule) → 404.
      const crossPatch = await idRoute.PATCH(fakeRequest({ body: { enabled: false } }), {
        params: { id: String(rule.id) },
      });
      expect(crossPatch.status).toBe(404);
    } finally {
      await pool.query(`DELETE FROM mailbox.prompt_rules WHERE account_id = $1`, [acct2]);
      await pool.query(`DELETE FROM mailbox.accounts WHERE id = $1`, [acct2]);
    }
  });
});
