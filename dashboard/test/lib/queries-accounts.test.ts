import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountMutationError,
  accountHasData,
  createAccount,
  deleteAccount,
  getDefaultAccountId,
  listAccountsDetailed,
  setDefaultAccount,
  updateAccount,
} from '@/lib/queries-accounts';
import {
  closeTestPool,
  deleteSeededDraft,
  getTestPool,
  HAS_DB,
  type SeededDraft,
  seedDraft,
} from '../helpers/db';

// MBOX-366 (MBOX-162 V5) — account registry CRUD. DB-backed: skips without
// TEST_POSTGRES_URL (same gate as the route suites). The shared Postgres runs
// serial (vitest fileParallelism:false), so this suite is meticulous about
// restoring the seeded default account + deleting every row it creates —
// other files assume exactly one default with mail flowing to it.

const dbDescribe = HAS_DB ? describe : describe.skip;

// Unique per run so reruns against a persistent DB never collide on the
// email_address UNIQUE constraint.
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const emailFor = (tag: string) => `v5-${tag}-${stamp}@example.test`;

dbDescribe('queries-accounts CRUD — real Postgres', () => {
  let originalDefaultId: number;
  const createdIds = new Set<number>();
  const seededDrafts: SeededDraft[] = [];

  beforeAll(async () => {
    originalDefaultId = await getDefaultAccountId();
  });

  afterEach(async () => {
    // Restore the seeded default so a set-default test never leaves the box
    // pointing at a temp account other files will then delete.
    const current = await getDefaultAccountId().catch(() => undefined);
    if (current !== originalDefaultId) {
      await setDefaultAccount(originalDefaultId);
    }
  });

  afterAll(async () => {
    for (const s of seededDrafts) await deleteSeededDraft(s);
    const pool = getTestPool();
    for (const id of createdIds) {
      await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [id]);
    }
    await closeTestPool();
  });

  it('creates a non-default account with provider + created_at', async () => {
    const acct = await createAccount({
      email_address: emailFor('create'),
      display_label: 'Consulting',
      provider: 'gmail',
    });
    createdIds.add(acct.id);

    expect(acct.is_default).toBe(false);
    expect(acct.provider).toBe('gmail');
    expect(acct.display_label).toBe('Consulting');
    expect(typeof acct.created_at).toBe('string');

    const all = await listAccountsDetailed();
    expect(all.some((a) => a.id === acct.id)).toBe(true);
    // Default-first ordering.
    expect(all[0].is_default).toBe(true);
  });

  it('rejects a duplicate email_address with AccountMutationError', async () => {
    const email = emailFor('dup');
    const first = await createAccount({
      email_address: email,
      display_label: null,
      provider: 'gmail',
    });
    createdIds.add(first.id);

    await expect(
      createAccount({ email_address: email, display_label: null, provider: 'gmail' }),
    ).rejects.toMatchObject({ name: 'AccountMutationError', code: 'duplicate_email' });
  });

  it('updates the label in place, leaving email immutable', async () => {
    const acct = await createAccount({
      email_address: emailFor('rename'),
      display_label: 'Before',
      provider: 'gmail',
    });
    createdIds.add(acct.id);

    const updated = await updateAccount(acct.id, { display_label: 'After' });
    expect(updated?.display_label).toBe('After');
    expect(updated?.email_address).toBe(acct.email_address);

    // Clearing the label → null.
    const cleared = await updateAccount(acct.id, { display_label: null });
    expect(cleared?.display_label).toBeNull();
  });

  it('updateAccount returns null for a missing id', async () => {
    expect(await updateAccount(2_000_000_000, { display_label: 'x' })).toBeNull();
  });

  it('set-default swaps the default and keeps exactly one', async () => {
    const acct = await createAccount({
      email_address: emailFor('default'),
      display_label: 'Founder',
      provider: 'gmail',
    });
    createdIds.add(acct.id);

    const promoted = await setDefaultAccount(acct.id);
    expect(promoted.is_default).toBe(true);

    const all = await listAccountsDetailed();
    const defaults = all.filter((a) => a.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(acct.id);
    // afterEach restores originalDefaultId.
  });

  it('set-default throws not_found for a missing id', async () => {
    await expect(setDefaultAccount(2_000_000_001)).rejects.toMatchObject({
      name: 'AccountMutationError',
      code: 'not_found',
    });
  });

  it('refuses to delete the default inbox', async () => {
    await expect(deleteAccount(originalDefaultId)).rejects.toMatchObject({
      name: 'AccountMutationError',
      code: 'cannot_delete_default',
    });
  });

  it('refuses to delete an account that has mail/draft history', async () => {
    const acct = await createAccount({
      email_address: emailFor('hasdata'),
      display_label: null,
      provider: 'gmail',
    });
    createdIds.add(acct.id);

    const seeded = await seedDraft({ accountId: acct.id });
    seededDrafts.push(seeded);

    expect(await accountHasData(acct.id)).toBe(true);
    await expect(deleteAccount(acct.id)).rejects.toMatchObject({
      name: 'AccountMutationError',
      code: 'account_has_data',
    });
  });

  it('deletes a clean non-default account; missing id returns false', async () => {
    const acct = await createAccount({
      email_address: emailFor('clean'),
      display_label: null,
      provider: 'gmail',
    });

    expect(await accountHasData(acct.id)).toBe(false);
    expect(await deleteAccount(acct.id)).toBe(true);
    // Already gone → false (not an error).
    expect(await deleteAccount(acct.id)).toBe(false);
  });
});

// Guard so the suite isn't silently empty in environments without a DB.
describe('queries-accounts CRUD — guard', () => {
  it(HAS_DB ? 'runs against Postgres' : 'skips without TEST_POSTGRES_URL', () => {
    expect(typeof AccountMutationError).toBe('function');
  });
});
