// dashboard/scripts/kb-smoke.ts
//
// STAQPRO-148 — pre-route smoke test for the KB ingest pipeline. Exercises
// the entire backend stack (parser → chunker → embed → Qdrant upsert →
// search → cascade delete → reconciler) against the live appliance infra
// (Postgres + Qdrant + Ollama) WITHOUT needing the HTTP upload route or
// the UI to exist yet.
//
// Run on Bob:
//   ssh mailbox1 'cd ~/mailbox && \
//     docker compose --profile migrate run --rm \
//       --entrypoint sh mailbox-migrate \
//       -c "npm install --silent --no-audit --no-fund && npx tsx scripts/kb-smoke.ts"'
//
// What it validates:
//   1. pdf-parse + mammoth + native txt parsers load on ARM64 (Jetson)
//   2. KB_STORAGE_DIR is writable + sha256-keyed file lifecycle works
//   3. embedText() reaches Ollama and returns 768-dim vectors
//   4. upsertKbPoint() round-trips through Qdrant correctly
//   5. searchKb() returns the chunks we just upserted
//   6. status transitions: processing → ready (with chunk_count populated)
//   7. deleteKbPointsByDocId() purges Qdrant points
//   8. reconcileStuckKbDocs() flips stuck rows to 'failed'
//
// Cleanup: removes its own kb_documents rows + Qdrant points + filesystem
// artifacts. Safe to re-run.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import { getDefaultAccountId } from '@/lib/queries-accounts';
import {
  deleteKbDocument,
  getKbDocument,
  insertKbDocument,
  listStuckProcessingDocs,
} from '@/lib/queries-kb';
import { embedText } from '@/lib/rag/embed';
import {
  deleteKbFile,
  embedAndUpsertChunks,
  KB_STORAGE_DIR,
  kbStoragePath,
  writeKbFile,
} from '@/lib/rag/kb-ingest';
import { deleteKbPointsByDocId, searchKb } from '@/lib/rag/kb-qdrant';

// Small embedded SOP fixture — real-shaped: paragraphs, headings, the kind
// of content an operator might upload (this one is a Heron Labs returns
// policy from the customer-#1 corpus, kept as historical test data; the
// product is industry-agnostic per the 2026-05-08 CPG-scrub but the
// fixture content is preserved for test stability). ~1.5KB so it produces
// 1-2 chunks.
const FIXTURE_TEXT = `# Returns Policy

Heron Labs accepts returns within 30 days of delivery for any product
defect or shipping damage. Customers must include the original packing
slip and email returns@heronlabs.com to request an RMA number before
shipping the item back.

# Refund Process

Refunds are processed within 5 business days of receiving the returned
product at our warehouse. Refunds go back to the original payment
method; we do not issue store credit unless the customer explicitly
requests it.

For wholesale orders, refunds require a separate approval from the
account manager and may take up to 10 business days.

# Minimum Order Quantities

Wholesale MOQ for our standard SKUs is 144 units. Custom-formulation
SKUs have a 500-unit MOQ and a 6-week lead time.

Sample requests are limited to 3 units per SKU per quarter and are
free for prospective wholesale accounts.

# Cancellation Policy

Orders can be cancelled within 24 hours of placement at no charge.
After 24 hours, a 15% restocking fee applies. Once an order ships, it
falls under the standard returns policy above.`;

const FIXTURE_FILENAME = 'kb-smoke-returns-policy.md';
const FIXTURE_MIME = 'text/markdown';

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  const icon = ok ? '✓' : '✗';
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  console.log(`[kb-smoke] target Postgres via getKysely()`);
  console.log(`[kb-smoke] KB_STORAGE_DIR=${KB_STORAGE_DIR}`);
  console.log('');

  const buffer = Buffer.from(FIXTURE_TEXT, 'utf8');
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const ext = 'md';

  // ── Phase 1: filesystem + insert ─────────────────────────────────────────
  console.log('[1/6] Filesystem + insertKbDocument');
  let docId: number | null = null;
  try {
    const filePath = await writeKbFile(sha256, ext, buffer);
    const exists = await fs
      .stat(filePath)
      .then(() => true)
      .catch(() => false);
    check('writeKbFile creates the sha256-keyed file', exists, filePath);

    const doc = await insertKbDocument({
      account_id: await getDefaultAccountId(),
      title: 'kb-smoke Returns Policy',
      filename: FIXTURE_FILENAME,
      mime_type: FIXTURE_MIME,
      size_bytes: buffer.byteLength,
      sha256,
      uploaded_by: 'kb-smoke-script',
      metadata: { smoke: true, sha256_prefix: sha256.slice(0, 12) },
    });
    docId = doc.id;
    check(
      'insertKbDocument returns row with status=processing',
      doc.status === 'processing',
      `doc_id=${doc.id}`,
    );
  } catch (error) {
    check('Phase 1 setup', false, error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  // ── Phase 2: embed + upsert via the orchestrator ─────────────────────────
  console.log('');
  console.log('[2/6] embedAndUpsertChunks (parser → chunker → embed → Qdrant)');
  const ingestResult = await embedAndUpsertChunks(docId);
  check(
    'embedAndUpsertChunks returns ok=true',
    ingestResult.ok,
    `chunkCount=${ingestResult.chunkCount}${ingestResult.error ? ` error=${ingestResult.error}` : ''}`,
  );
  check('chunkCount > 0', ingestResult.chunkCount > 0, `${ingestResult.chunkCount} chunks`);

  const docAfter = await getKbDocument(docId);
  check(
    'kb_documents.status flipped to ready',
    docAfter?.status === 'ready',
    `status=${docAfter?.status} chunk_count=${docAfter?.chunk_count} ready_at=${docAfter?.ready_at}`,
  );

  // ── Phase 3: search round-trip ───────────────────────────────────────────
  console.log('');
  console.log('[3/6] searchKb round-trip');
  const queryEmbedding = await embedText('What is the wholesale minimum order quantity?');
  check(
    'embedText returns 768d vector',
    queryEmbedding?.length === 768,
    `len=${queryEmbedding?.length ?? 'null'}`,
  );

  if (queryEmbedding) {
    const search = await searchKb(queryEmbedding, { limit: 3 });
    check('searchKb ok=true', search.ok, search.reason ?? '');
    check('search returns at least one hit', search.hits.length > 0, `${search.hits.length} hits`);
    if (search.hits.length > 0) {
      const top = search.hits[0];
      const looksRelevant = top.payload.excerpt.toLowerCase().includes('moq');
      check(
        'top hit excerpt mentions MOQ (semantic match working)',
        looksRelevant,
        `score=${top.score.toFixed(3)} doc_id=${top.payload.doc_id} chunk=${top.payload.chunk_index}`,
      );
    }
  }

  // ── Phase 4: cascade delete (Qdrant points by doc_id) ────────────────────
  console.log('');
  console.log('[4/6] deleteKbPointsByDocId (cascade)');
  const del = await deleteKbPointsByDocId(docId);
  check('deleteKbPointsByDocId ok=true', del.ok, del.reason ?? '');

  if (queryEmbedding) {
    const searchAfter = await searchKb(queryEmbedding, { limit: 3 });
    const ourPointsGone = !searchAfter.hits.some((h) => h.payload.doc_id === docId);
    check(
      'searchKb no longer returns deleted doc',
      ourPointsGone,
      `${searchAfter.hits.length} hits remain (none ours)`,
    );
  }

  // ── Phase 5: row + file cleanup ──────────────────────────────────────────
  console.log('');
  console.log('[5/6] deleteKbDocument + deleteKbFile');
  const delRow = await deleteKbDocument(docId);
  check(
    'deleteKbDocument returns sha256',
    delRow?.sha256 === sha256,
    `sha=${delRow?.sha256?.slice(0, 12)}…`,
  );

  await deleteKbFile(sha256, ext);
  const fileGone = !(await fs
    .stat(kbStoragePath(sha256, ext))
    .then(() => true)
    .catch(() => false));
  check('sha256-keyed file removed from disk', fileGone, kbStoragePath(sha256, ext));

  const finalDoc = await getKbDocument(docId);
  check('kb_documents row gone after deleteKbDocument', finalDoc === null);

  // ── Phase 6: reconciler ──────────────────────────────────────────────────
  console.log('');
  console.log('[6/6] reconcileStuckKbDocs (insert stuck row, run reconciler, verify flip)');
  const stuckSha = createHash('sha256').update(`kb-smoke-stuck-${Date.now()}`).digest('hex');
  const db = getKysely();
  const stuck = await db
    .insertInto('kb_documents')
    .values({
      title: 'kb-smoke stuck row',
      filename: 'kb-smoke-stuck.txt',
      mime_type: 'text/plain',
      size_bytes: 1,
      sha256: stuckSha,
      status: 'processing',
      processing_started_at: sql<string>`NOW() - INTERVAL '10 minutes'`,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  const stuckId = Number(stuck.id);

  const matched = await listStuckProcessingDocs(5);
  const includesOurs = matched.some((d) => d.id === stuckId);
  check('listStuckProcessingDocs(5) finds our 10-min-old row', includesOurs);

  // Inline the reconciler body to avoid the once-per-process latch in
  // reconcileOnce (which we'd need to flip via _resetReconcilerLatchForTests).
  const { reconcileStuckKbDocs } = await import('@/lib/rag/kb-reconciler');
  const recon = await reconcileStuckKbDocs();
  check(
    'reconcileStuckKbDocs flipped at least 1 row',
    recon.flipped >= 1,
    `flipped=${recon.flipped}`,
  );

  const stuckAfter = await getKbDocument(stuckId);
  check(
    "stuck row flipped to status='failed'",
    stuckAfter?.status === 'failed',
    `error_message=${stuckAfter?.error_message}`,
  );

  // Cleanup the stuck row.
  await deleteKbDocument(stuckId);
  check('stuck row cleaned up', (await getKbDocument(stuckId)) === null);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('');
  const failures = results.filter((r) => !r.ok);
  console.log(`[kb-smoke] ${results.length - failures.length}/${results.length} checks passed`);
  if (failures.length > 0) {
    console.log('[kb-smoke] FAILURES:');
    for (const f of failures) {
      console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    }
    process.exitCode = 1;
  } else {
    console.log('[kb-smoke] all checks passed — Commits 3-6 land on validated infra');
  }
}

main().catch((err) => {
  console.error('[kb-smoke] threw:', err);
  process.exit(2);
});
