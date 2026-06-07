// MBOX-348 (MBOX-162 V1) — one-shot Qdrant re-tag for the account_id dimension.
//
// Migration 033 added account_id to every account-scoped SQL table and backfilled
// it to the seeded default account. The Qdrant `email_messages` collection mirrors
// that dimension into each point's payload (lib/rag/qdrant.ts EmailPointPayload),
// but existing points predate the field. This script sets payload.account_id =
// <default account id> on every point that is MISSING it.
//
// SAFETY / IDEMPOTENCE: the set-payload is filtered to points where account_id
// is_empty, so (a) re-running is a no-op and (b) running it AFTER a second
// account exists will NOT reassign that account's already-tagged points to the
// default. It only ever fills in the gap left by the pre-migration points.
//
// Run as part of the same deploy as migration 033 (see the V1 runbook):
//   docker exec mailbox-dashboard npx tsx scripts/retag-qdrant-account-id.ts
//
// Env: QDRANT_URL (default http://qdrant:6333), POSTGRES_URL (for the default
// account id). DRY_RUN=1 prints the counts without mutating.

import { Pool } from 'pg';

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333';
const COLLECTION = 'email_messages';
const DRY_RUN = process.env.DRY_RUN === '1';

const untaggedFilter = { must: [{ is_empty: { key: 'account_id' } }] };

async function qdrant(
  method: 'POST',
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function countUntagged(): Promise<number> {
  const r = await qdrant('POST', `/collections/${COLLECTION}/points/count`, {
    filter: untaggedFilter,
    exact: true,
  });
  if (r.status !== 200) {
    throw new Error(`qdrant count failed (${r.status}): ${JSON.stringify(r.json)}`);
  }
  return (r.json as { result?: { count?: number } }).result?.count ?? 0;
}

async function main(): Promise<void> {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL not set');

  const pool = new Pool({ connectionString: url, max: 1 });
  const { rows } = await pool.query<{ id: number }>(
    'SELECT id FROM mailbox.accounts WHERE is_default',
  );
  await pool.end();
  if (rows.length === 0) {
    throw new Error('no default account — run migration 033 first');
  }
  const defaultAccountId = rows[0]?.id;
  if (defaultAccountId === undefined) throw new Error('default account id missing');

  const before = await countUntagged();
  console.log(`[retag] default account id = ${defaultAccountId}`);
  console.log(`[retag] points missing account_id: ${before}`);

  if (before === 0) {
    console.log('[retag] nothing to do — all points already carry account_id');
    return;
  }
  if (DRY_RUN) {
    console.log(`[retag] DRY_RUN=1 — would set account_id=${defaultAccountId} on ${before} points`);
    return;
  }

  // wait=true so the count below reflects the applied mutation.
  const r = await qdrant('POST', `/collections/${COLLECTION}/points/payload?wait=true`, {
    payload: { account_id: defaultAccountId },
    filter: untaggedFilter,
  });
  if (r.status !== 200) {
    throw new Error(`qdrant set-payload failed (${r.status}): ${JSON.stringify(r.json)}`);
  }

  const after = await countUntagged();
  console.log(`[retag] set account_id=${defaultAccountId} on ${before} points`);
  console.log(`[retag] points still missing account_id: ${after}`);
  if (after !== 0) {
    throw new Error(`[retag] ${after} points still untagged after set-payload — investigate`);
  }
  console.log('[retag] complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
