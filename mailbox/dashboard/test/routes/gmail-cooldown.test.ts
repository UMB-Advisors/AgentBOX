// MBOX-107 — coverage for the force-resume escape hatch on the
// system-wide Gmail rate-limit cooldown.
//
// Scope: only the NEW surface (clearGmailCooldown + the DELETE handler).
// Existing read-side coverage (getGmailCooldown, setGmailCooldown, the
// gmail-ratelimit-sweeper) lives under STAQPRO-227/231 and is not
// re-asserted here.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearGmailCooldown,
  getGmailCooldown,
  getMailCooldown,
  setGmailCooldown,
} from '@/lib/queries-system-state';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('Gmail cooldown force-resume — real Postgres', () => {
  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(async () => {
    // Reset the default account's gmail cooldown bucket to baseline. Since
    // migration 039 the SoT is mailbox.mail_cooldowns (keyed account_id,
    // provider); the helpers upsert the row on demand, so DELETE is a clean reset.
    const pool = getTestPool();
    await pool.query(`
      DELETE FROM mailbox.mail_cooldowns
       WHERE provider = 'gmail'
         AND account_id = (SELECT id FROM mailbox.accounts WHERE is_default)
    `);
  });

  describe('clearGmailCooldown helper', () => {
    it('clears an active cooldown and returns the previous deadline', async () => {
      const future = new Date(Date.now() + 30 * 60 * 1000); // +30 min
      await setGmailCooldown(future);

      const result = await clearGmailCooldown();
      expect(result.cleared).toBe(true);
      expect(result.previous_until).toBeInstanceOf(Date);
      // Cooldown timestamps round-trip via Postgres TIMESTAMPTZ — compare
      // by ISO string to avoid millisecond drift on the wire.
      expect(result.previous_until?.toISOString()).toBe(future.toISOString());

      // Verify the row was actually nulled in mail_cooldowns (the SoT since 039).
      const pool = getTestPool();
      const { rows } = await pool.query<{
        until: string | null;
        set_at: string | null;
      }>(`
        SELECT mc.until, mc.set_at
          FROM mailbox.mail_cooldowns mc
          JOIN mailbox.accounts a ON a.id = mc.account_id
         WHERE a.is_default AND mc.provider = 'gmail'
      `);
      expect(rows[0]?.until ?? null).toBeNull();
      expect(rows[0]?.set_at ?? null).toBeNull();
    });

    it('is idempotent — clearing an already-cleared cooldown is a no-op success', async () => {
      // No setGmailCooldown call — baseline is already nulled by beforeEach.
      const result = await clearGmailCooldown();
      expect(result.cleared).toBe(false);
      expect(result.previous_until).toBeNull();
    });
  });

  describe('DELETE /api/system/gmail-cooldown', () => {
    it('clears an active cooldown and returns previous_until', async () => {
      const future = new Date(Date.now() + 30 * 60 * 1000);
      await setGmailCooldown(future);

      const { DELETE } = await import('@/app/api/system/gmail-cooldown/route');
      const res = await DELETE();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { cleared: boolean; previous_until: string | null };
      expect(body.cleared).toBe(true);
      expect(body.previous_until).toBe(future.toISOString());

      // GET should now report inactive — round-trip through the operator-
      // facing read so we also assert the route layer agrees the gate is
      // open.
      const { GET } = await import('@/app/api/system/gmail-cooldown/route');
      const getRes = await GET();
      const getBody = (await getRes.json()) as { is_active: boolean; until: string | null };
      expect(getBody.is_active).toBe(false);
      expect(getBody.until).toBeNull();
    });

    it('returns 200 with cleared:false when no cooldown was active', async () => {
      const { DELETE } = await import('@/app/api/system/gmail-cooldown/route');
      const res = await DELETE();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { cleared: boolean; previous_until: string | null };
      expect(body.cleared).toBe(false);
      expect(body.previous_until).toBeNull();
    });
  });
});

// MBOX-357 (P1 T5) — provider-generic getMailCooldown over mail_cooldowns. The
// load-bearing invariant: an IMAP cooldown is isolated from the Gmail bucket so
// a Gmail 429 can't pause an IMAP send (DR-57 / migration 039). The send gate
// in transitions.ts depends on exactly this.
dbDescribe('getMailCooldown — per-(account, provider) isolation', () => {
  let defaultAccountId: number;

  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(async () => {
    const pool = getTestPool();
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM mailbox.accounts WHERE is_default`,
    );
    defaultAccountId = rows[0].id;
    // Reset both transports' buckets for the default account to baseline.
    await pool.query(
      `DELETE FROM mailbox.mail_cooldowns WHERE account_id = $1 AND provider IN ('gmail', 'imap')`,
      [defaultAccountId],
    );
  });

  it('returns the inactive shape when the (account, provider) row is absent', async () => {
    const cd = await getMailCooldown(defaultAccountId, 'imap');
    expect(cd.isActive).toBe(false);
    expect(cd.until).toBeNull();
  });

  it('reports an active imap cooldown without touching the gmail bucket', async () => {
    const pool = getTestPool();
    const future = new Date(Date.now() + 30 * 60 * 1000); // +30 min
    await pool.query(
      `INSERT INTO mailbox.mail_cooldowns (account_id, provider, until, set_at)
       VALUES ($1, 'imap', $2::timestamptz, NOW())`,
      [defaultAccountId, future.toISOString()],
    );

    const imap = await getMailCooldown(defaultAccountId, 'imap');
    expect(imap.isActive).toBe(true);
    expect(imap.until?.toISOString()).toBe(future.toISOString());

    // The gmail bucket is untouched — proving a Gmail 429 and an IMAP throttle
    // are independent (the whole point of migration 039).
    expect((await getMailCooldown(defaultAccountId, 'gmail')).isActive).toBe(false);
    expect((await getGmailCooldown()).isActive).toBe(false);
  });
});
