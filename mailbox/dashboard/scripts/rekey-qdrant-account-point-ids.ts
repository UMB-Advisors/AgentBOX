// MBOX-352 (MBOX-162 V2) — one-shot Qdrant migration for per-account isolation.
//
// V1 (retag-qdrant-account-id.ts) added payload.account_id to existing
// email_messages points but left their point IDs keyed on message_id alone.
// V2 keys new email points on sha256(account_id:message_id) (lib/rag/qdrant.ts
// pointIdFromAccountMessage) so the same Gmail message in two inboxes no longer
// collides. This script reconciles the EXISTING corpus with the new scheme:
//
//   email_messages — re-point: for every point whose id != the account-scoped
//     id, copy it to the new id (same vector + payload) and delete the old one.
//     Idempotent: points already on the new id are skipped.
//   kb_documents   — payload-tag: KB keying (sha256+chunk_index) is unchanged,
//     so KB points only need payload.account_id added (the V1 retag covered
//     email but NOT kb). Derived from the kb_documents table (doc_id → account).
//     Only after this runs is the searchKb accountFilter safe to enable.
//
// NOT auto-run by any migration or deploy. It is MOOT while the appliance has a
// single account (one account → the account filter already matches every point,
// and the dual-key self-exclude in retrieve.ts already drops the legacy id).
// Run it at the deploy that connects a 2nd inbox, AFTER migration 036:
//   docker exec mailbox-dashboard npx tsx scripts/rekey-qdrant-account-point-ids.ts
//
// Env: QDRANT_URL (default http://qdrant:6333), POSTGRES_URL. DRY_RUN=1 prints
// the planned mutations without applying them.

import { Pool } from 'pg';
import { type EmailPointPayload, pointIdFromAccountMessage } from '../lib/rag/qdrant';

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333';
const DRY_RUN = process.env.DRY_RUN === '1';
const PAGE = 256;

async function qdrant(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

interface ScrolledPoint {
  id: string;
  vector: number[];
  payload: EmailPointPayload;
}

// Scroll an entire collection, paginating on the returned offset cursor.
async function* scrollAll(collection: string, withVector: boolean): AsyncGenerator<ScrolledPoint> {
  let offset: unknown;
  for (;;) {
    const r = await qdrant(`/collections/${collection}/points/scroll`, {
      limit: PAGE,
      with_payload: true,
      with_vector: withVector,
      ...(offset !== undefined && offset !== null ? { offset } : {}),
    });
    if (r.status !== 200) {
      throw new Error(`scroll ${collection} failed (${r.status}): ${JSON.stringify(r.json)}`);
    }
    const result = (r.json as { result?: { points?: unknown[]; next_page_offset?: unknown } })
      .result;
    const points = (result?.points ?? []) as Array<{
      id: string;
      vector?: number[];
      payload?: EmailPointPayload;
    }>;
    for (const p of points) {
      yield { id: p.id, vector: p.vector ?? [], payload: (p.payload ?? {}) as EmailPointPayload };
    }
    offset = result?.next_page_offset ?? null;
    if (offset === null || offset === undefined || points.length === 0) break;
  }
}

async function rekeyEmail(): Promise<void> {
  let scanned = 0;
  let toMove = 0;
  const oldIdsToDelete: string[] = [];
  const newPoints: Array<{ id: string; vector: number[]; payload: EmailPointPayload }> = [];

  for await (const p of scrollAll('email_messages', true)) {
    scanned++;
    const acct = p.payload?.account_id;
    const messageId = p.payload?.message_id;
    if (acct === undefined || acct === null || !messageId) {
      console.warn(
        `[rekey-email] point ${p.id} missing account_id/message_id in payload — skipped`,
      );
      continue;
    }
    const newId = pointIdFromAccountMessage(acct, messageId);
    if (newId === p.id) continue; // already account-keyed
    toMove++;
    newPoints.push({ id: newId, vector: p.vector, payload: p.payload });
    oldIdsToDelete.push(p.id);
  }

  console.log(`[rekey-email] scanned ${scanned} points; ${toMove} need re-keying`);
  if (toMove === 0) {
    console.log('[rekey-email] nothing to do — all email points already account-keyed');
    return;
  }
  if (DRY_RUN) {
    console.log(
      `[rekey-email] DRY_RUN=1 — would upsert ${newPoints.length} new ids + delete ${oldIdsToDelete.length} old ids`,
    );
    return;
  }

  // Upsert new ids first (so a crash between steps leaves the data reachable
  // under BOTH ids — retrieve.ts dual-key self-exclude tolerates that), then
  // delete the old ids.
  for (let i = 0; i < newPoints.length; i += PAGE) {
    const batch = newPoints.slice(i, i + PAGE);
    const r = await qdrant('/collections/email_messages/points?wait=true', { points: batch });
    if (r.status !== 200) {
      throw new Error(`[rekey-email] upsert failed (${r.status}): ${JSON.stringify(r.json)}`);
    }
  }
  for (let i = 0; i < oldIdsToDelete.length; i += PAGE) {
    const batch = oldIdsToDelete.slice(i, i + PAGE);
    const r = await qdrant('/collections/email_messages/points/delete?wait=true', {
      points: batch,
    });
    if (r.status !== 200) {
      throw new Error(`[rekey-email] delete failed (${r.status}): ${JSON.stringify(r.json)}`);
    }
  }
  console.log(`[rekey-email] re-keyed ${toMove} points (upserted new ids, deleted old ids)`);
}

async function tagKb(pool: Pool): Promise<void> {
  // doc_id → account_id from the source of truth.
  const { rows } = await pool.query<{ id: number; account_id: number }>(
    'SELECT id, account_id FROM mailbox.kb_documents',
  );
  const docAccount = new Map<number, number>(rows.map((r) => [r.id, r.account_id]));

  let scanned = 0;
  let tagged = 0;
  // Group point ids by the account they should carry, then one set-payload per
  // account (set-payload takes a points list).
  const byAccount = new Map<number, string[]>();
  for await (const p of scrollAll('kb_documents', false)) {
    scanned++;
    const docId = (p.payload as unknown as { doc_id?: number }).doc_id;
    const existing = (p.payload as unknown as { account_id?: number }).account_id;
    if (docId === undefined) continue;
    if (existing !== undefined && existing !== null) continue; // already tagged
    const acct = docAccount.get(docId);
    if (acct === undefined) {
      console.warn(`[tag-kb] point ${p.id} → doc_id ${docId} not in kb_documents — skipped`);
      continue;
    }
    const list = byAccount.get(acct) ?? [];
    list.push(p.id);
    byAccount.set(acct, list);
    tagged++;
  }

  console.log(`[tag-kb] scanned ${scanned} points; ${tagged} need account_id`);
  if (tagged === 0) {
    console.log('[tag-kb] nothing to do — all KB points already carry account_id');
    return;
  }
  if (DRY_RUN) {
    console.log(
      `[tag-kb] DRY_RUN=1 — would tag ${tagged} points across ${byAccount.size} account(s)`,
    );
    return;
  }
  for (const [acct, ids] of byAccount) {
    for (let i = 0; i < ids.length; i += PAGE) {
      const batch = ids.slice(i, i + PAGE);
      const r = await qdrant('/collections/kb_documents/points/payload?wait=true', {
        payload: { account_id: acct },
        points: batch,
      });
      if (r.status !== 200) {
        throw new Error(`[tag-kb] set-payload failed (${r.status}): ${JSON.stringify(r.json)}`);
      }
    }
  }
  console.log(`[tag-kb] tagged ${tagged} KB points with account_id`);
}

async function main(): Promise<void> {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL not set');
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await rekeyEmail();
    await tagKb(pool);
    console.log('[rekey] complete');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
