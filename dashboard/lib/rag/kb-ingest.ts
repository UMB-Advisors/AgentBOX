// dashboard/lib/rag/kb-ingest.ts
//
// STAQPRO-148 — KB document ingestion orchestrator. Reads the original
// file from /var/lib/mailbox/kb/<sha256>.<ext>, parses by mime, chunks,
// embeds each chunk, upserts to Qdrant, then flips kb_documents.status
// from 'processing' → 'ready' (with chunk_count) or 'failed' (with
// error_message).
//
// Caller pattern (from /api/kb-documents POST route):
//   const doc = await insertKbDocument({...});  // status='processing'
//   void embedAndUpsertChunks(doc.id);          // fire-and-forget
//   return res.json({ doc_id: doc.id, status: 'processing' });
//
// The fire-and-forget is safe because kb-reconciler runs on dashboard
// cold-start and flips any 'processing' rows older than 5 min to 'failed'
// (operator clicks Retry → calls embedAndUpsertChunks against the
// already-stored sha256 file). No queue needed.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getKysely } from '@/lib/db';
import { getKbDocument, updateKbDocumentStatus } from '@/lib/queries-kb';
import { embedText } from '@/lib/rag/embed';
import { chunkText } from '@/lib/rag/kb-chunker';
import { parseDocument } from '@/lib/rag/kb-parsers';
import { type KbPointPayload, upsertKbPoint } from '@/lib/rag/kb-qdrant';

export const KB_STORAGE_DIR = process.env.KB_STORAGE_DIR ?? '/var/lib/mailbox/kb';
const EMBED_INPUT_CHAR_CAP = Number(process.env.KB_EMBED_INPUT_CHAR_CAP ?? 4000);
const PAYLOAD_EXCERPT_CHAR_CAP = Number(process.env.KB_PAYLOAD_EXCERPT_CHAR_CAP ?? 1200);

// Maps a stored sha256 + filename extension to the on-disk path. Caller
// (the upload route) decides the extension based on the original filename;
// we just join here so both write + read agree on the location.
export function kbStoragePath(sha256: string, ext: string): string {
  // Strip leading dots so callers can pass either '.pdf' or 'pdf'.
  const safe = ext.replace(/^\.+/, '');
  return path.join(KB_STORAGE_DIR, `${sha256}.${safe}`);
}

export async function ensureStorageDir(): Promise<void> {
  await fs.mkdir(KB_STORAGE_DIR, { recursive: true });
}

export async function writeKbFile(sha256: string, ext: string, buffer: Buffer): Promise<string> {
  await ensureStorageDir();
  const filePath = kbStoragePath(sha256, ext);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

export async function deleteKbFile(sha256: string, ext: string): Promise<void> {
  const filePath = kbStoragePath(sha256, ext);
  await fs.rm(filePath, { force: true });
}

interface IngestResult {
  ok: boolean;
  chunkCount: number;
  error?: string;
}

export async function embedAndUpsertChunks(doc_id: number): Promise<IngestResult> {
  const doc = await getKbDocument(doc_id);
  if (!doc) {
    return { ok: false, chunkCount: 0, error: `kb_documents row ${doc_id} not found` };
  }

  // MBOX-352 (MBOX-162 V2) — the owning account is stamped into every KB point
  // so per-account KB isolation can filter on it once the corpus is retagged.
  // Read directly: the curated KbDocument view doesn't expose account_id, and
  // this is a once-per-upload cost.
  const acctRow = await getKysely()
    .selectFrom('kb_documents')
    .select('account_id')
    .where('id', '=', doc_id)
    .executeTakeFirst();
  const accountId = acctRow?.account_id;

  try {
    const ext = path.extname(doc.filename).replace(/^\.+/, '') || 'bin';
    const filePath = kbStoragePath(doc.sha256, ext);
    const buffer = await fs.readFile(filePath);

    const { text } = await parseDocument(buffer, doc.mime_type, doc.filename);
    const chunks = chunkText(text);

    if (chunks.length === 0) {
      await updateKbDocumentStatus(doc_id, {
        status: 'failed',
        error_message: 'no chunks produced (empty document?)',
      });
      return { ok: false, chunkCount: 0, error: 'no chunks produced' };
    }

    let upsertedCount = 0;
    for (const chunk of chunks) {
      const vector = await embedText(chunk.text.slice(0, EMBED_INPUT_CHAR_CAP));
      if (!vector) {
        await updateKbDocumentStatus(doc_id, {
          status: 'failed',
          error_message: `embed_unavailable at chunk ${chunk.index}`,
          chunk_count: upsertedCount,
        });
        return { ok: false, chunkCount: upsertedCount, error: 'embed_unavailable' };
      }

      const payload: KbPointPayload = {
        doc_id: doc.id,
        chunk_index: chunk.index,
        doc_title: doc.title,
        doc_sha256: doc.sha256,
        mime_type: doc.mime_type,
        excerpt: chunk.text.slice(0, PAYLOAD_EXCERPT_CHAR_CAP),
        uploaded_at: doc.uploaded_at,
        account_id: accountId,
      };

      const upsert = await upsertKbPoint(vector, payload);
      if (!upsert.ok) {
        await updateKbDocumentStatus(doc_id, {
          status: 'failed',
          error_message: `qdrant_upsert_failed at chunk ${chunk.index}: ${upsert.reason ?? 'unknown'}`,
          chunk_count: upsertedCount,
        });
        return { ok: false, chunkCount: upsertedCount, error: upsert.reason };
      }
      upsertedCount += 1;
    }

    await updateKbDocumentStatus(doc_id, {
      status: 'ready',
      chunk_count: upsertedCount,
    });
    return { ok: true, chunkCount: upsertedCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    await updateKbDocumentStatus(doc_id, {
      status: 'failed',
      error_message: `ingest_threw: ${message}`,
    });
    return { ok: false, chunkCount: 0, error: message };
  }
}
