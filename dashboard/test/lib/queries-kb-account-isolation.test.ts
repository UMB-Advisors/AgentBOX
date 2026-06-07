import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deleteKbDocument,
  getKbDocumentBySha256,
  insertKbDocument,
  listKbDocuments,
} from '@/lib/queries-kb';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// MBOX-400 (MBOX-162 V7) — per-account knowledge-base isolation. DB-backed:
// skips without TEST_POSTGRES_URL. Migration 036 reshaped kb_documents'
// uniqueness from (sha256) to (account_id, sha256); these tests assert the
// query layer honors that — the SAME file lands as a distinct row under each
// inbox, dedup is per-account, and listing is scoped.

const dbDescribe = HAS_DB ? describe : describe.skip;

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
// A unique 64-hex sha256 the same file would produce — shared across both
// accounts so we exercise the (account_id, sha256) composite, not a collision.
const SHA = `${'a'.repeat(40)}${stamp.replace(/[^0-9a-f]/g, '0')}`.slice(0, 64).padEnd(64, '0');

dbDescribe('queries-kb per-account isolation — real Postgres', () => {
  let accountA: number; // seeded default account
  let accountB: number; // a 2nd connected inbox
  const docIds: number[] = [];

  beforeAll(async () => {
    const pool = getTestPool();
    const def = await pool.query<{ id: number }>(
      'SELECT id FROM mailbox.accounts WHERE is_default LIMIT 1',
    );
    accountA = def.rows[0].id;

    const b = await pool.query<{ id: number }>(
      `INSERT INTO mailbox.accounts (email_address, display_label, is_default, provider)
       VALUES ($1, 'Founder', false, 'gmail') RETURNING id`,
      [`kb-acct-b-${stamp}@example.test`],
    );
    accountB = b.rows[0].id;
  });

  afterAll(async () => {
    for (const id of docIds) await deleteKbDocument(id);
    const pool = getTestPool();
    await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [accountB]);
    await closeTestPool();
  });

  it('the same sha256 inserts as a distinct row under each account', async () => {
    const docA = await insertKbDocument({
      account_id: accountA,
      title: 'Returns Policy',
      filename: 'returns.md',
      mime_type: 'text/markdown',
      size_bytes: 123,
      sha256: SHA,
    });
    const docB = await insertKbDocument({
      account_id: accountB,
      title: 'Returns Policy',
      filename: 'returns.md',
      mime_type: 'text/markdown',
      size_bytes: 123,
      sha256: SHA,
    });
    docIds.push(docA.id, docB.id);

    expect(docA.id).not.toBe(docB.id);
    // insertKbDocument writes the owning inbox (not the column DEFAULT).
    expect(docA.account_id).toBe(accountA);
    expect(docB.account_id).toBe(accountB);
  });

  it('dedup lookup is per-account (same sha resolves to each inbox’s own row)', async () => {
    const a = await getKbDocumentBySha256(SHA, accountA);
    const b = await getKbDocumentBySha256(SHA, accountB);
    expect(a?.account_id).toBe(accountA);
    expect(b?.account_id).toBe(accountB);
    expect(a?.id).not.toBe(b?.id);
  });

  it('listing is scoped to the requested inbox', async () => {
    const aDocs = await listKbDocuments({ account_id: accountA });
    const bDocs = await listKbDocuments({ account_id: accountB });
    expect(aDocs.every((d) => d.account_id === accountA)).toBe(true);
    expect(bDocs.every((d) => d.account_id === accountB)).toBe(true);
    // Each inbox sees its own copy of the shared-sha doc, and not the other’s.
    expect(aDocs.some((d) => d.sha256 === SHA)).toBe(true);
    expect(aDocs.some((d) => d.account_id === accountB)).toBe(false);
    expect(bDocs.some((d) => d.account_id === accountA)).toBe(false);
  });
});

describe('queries-kb per-account isolation — guard', () => {
  it(HAS_DB ? 'runs against Postgres' : 'skips without TEST_POSTGRES_URL', () => {
    expect(typeof getKbDocumentBySha256).toBe('function');
  });
});
