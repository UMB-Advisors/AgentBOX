import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import type { KbDocStatus, KbDocument } from '@/lib/types';

// STAQPRO-148 — kysely query helpers for the knowledge-base corpus.
//
// Curated view boundary: rows project to KbDocument (lib/types.ts) — id +
// size_bytes are normalized to JS numbers at this layer (the DB BIGINT may
// surface as string depending on pg type parsers).

function toKbDocument(row: Record<string, unknown>): KbDocument {
  return {
    id: Number(row.id),
    account_id: Number(row.account_id),
    title: String(row.title),
    filename: String(row.filename),
    mime_type: String(row.mime_type),
    size_bytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    chunk_count: Number(row.chunk_count),
    status: row.status as KbDocStatus,
    error_message: (row.error_message as string | null) ?? null,
    uploaded_by: (row.uploaded_by as string | null) ?? null,
    uploaded_at: String(row.uploaded_at),
    processing_started_at: String(row.processing_started_at),
    ready_at: (row.ready_at as string | null) ?? null,
  };
}

export interface ListKbOpts {
  status?: KbDocStatus;
  limit?: number;
  // MBOX-400 (MBOX-162 V7) — scope the corpus listing to one inbox. Omitted →
  // every account's documents (single-account default + the "all inboxes" view).
  account_id?: number;
}

export async function listKbDocuments(opts: ListKbOpts = {}): Promise<KbDocument[]> {
  const db = getKysely();
  let q = db
    .selectFrom('kb_documents')
    .select([
      'id',
      'account_id',
      'title',
      'filename',
      'mime_type',
      'size_bytes',
      'sha256',
      'chunk_count',
      'status',
      'error_message',
      'uploaded_by',
      'uploaded_at',
      'processing_started_at',
      'ready_at',
    ])
    .orderBy('uploaded_at', 'desc')
    .limit(opts.limit ?? 200);

  if (opts.status) {
    q = q.where('status', '=', opts.status);
  }
  if (opts.account_id !== undefined) {
    q = q.where('account_id', '=', opts.account_id);
  }

  const rows = await q.execute();
  return rows.map(toKbDocument);
}

export async function getKbDocument(id: number): Promise<KbDocument | null> {
  const db = getKysely();
  const row = await db
    .selectFrom('kb_documents')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? toKbDocument(row as Record<string, unknown>) : null;
}

// MBOX-400 (MBOX-162 V7) — dedup is per-account. Migration 036 reshaped the
// unique key from (sha256) to (account_id, sha256) so two inboxes can each hold
// the same file; a global lookup would falsely report account B's upload as a
// duplicate of account A's and skip inserting B's row. accountId scopes it.
export async function getKbDocumentBySha256(
  sha256: string,
  accountId: number,
): Promise<KbDocument | null> {
  const db = getKysely();
  const row = await db
    .selectFrom('kb_documents')
    .selectAll()
    .where('sha256', '=', sha256)
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  return row ? toKbDocument(row as Record<string, unknown>) : null;
}

export interface InsertKbDocumentInput {
  // MBOX-400 (MBOX-162 V7) — which inbox owns this document. Written explicitly
  // rather than leaning on the column DEFAULT so a 2nd account's uploads aren't
  // silently misattributed to the default account; kb-ingest reads it back off
  // the row to tag the chunk payloads (lib/rag/kb-ingest.ts).
  account_id: number;
  title: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by?: string | null;
  metadata?: Record<string, unknown>;
}

export async function insertKbDocument(input: InsertKbDocumentInput): Promise<KbDocument> {
  const db = getKysely();
  const row = await db
    .insertInto('kb_documents')
    .values({
      account_id: input.account_id,
      title: input.title,
      filename: input.filename,
      mime_type: input.mime_type,
      size_bytes: input.size_bytes,
      sha256: input.sha256,
      uploaded_by: input.uploaded_by ?? null,
      metadata: sql`${JSON.stringify(input.metadata ?? {})}::jsonb`,
      // status, chunk_count, uploaded_at, processing_started_at all default
      // server-side per the migration 014 schema.
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toKbDocument(row as Record<string, unknown>);
}

export interface UpdateKbStatusInput {
  status: KbDocStatus;
  chunk_count?: number;
  error_message?: string | null;
  ready_at?: string;
}

export async function updateKbDocumentStatus(
  id: number,
  input: UpdateKbStatusInput,
): Promise<KbDocument | null> {
  const db = getKysely();
  const updates: Record<string, unknown> = { status: input.status };
  if (input.chunk_count !== undefined) updates.chunk_count = input.chunk_count;
  if (input.error_message !== undefined) updates.error_message = input.error_message;
  if (input.ready_at !== undefined) updates.ready_at = input.ready_at;
  // Auto-stamp ready_at when transitioning to 'ready' if caller didn't set it
  // explicitly. Other states leave it untouched.
  if (input.status === 'ready' && input.ready_at === undefined) {
    updates.ready_at = sql<string>`NOW()`;
  }

  const row = await db
    .updateTable('kb_documents')
    .set(updates)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
  return row ? toKbDocument(row as Record<string, unknown>) : null;
}

// Returns the sha256 of the deleted row so the caller can clean up the file
// on disk (and Qdrant points by doc_id payload filter). Returns null if no
// row matched the id (already deleted, or never existed).
export async function deleteKbDocument(id: number): Promise<{ sha256: string } | null> {
  const db = getKysely();
  const row = await db
    .deleteFrom('kb_documents')
    .where('id', '=', id)
    .returning(['sha256'])
    .executeTakeFirst();
  return row ? { sha256: String(row.sha256) } : null;
}

// Reconciler hot path. Finds rows stuck in 'processing' for longer than the
// given threshold (default 5 min). Used by lib/rag/kb-reconciler.ts on
// dashboard cold-start.
export async function listStuckProcessingDocs(thresholdMinutes = 5): Promise<KbDocument[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom('kb_documents')
    .selectAll()
    .where('status', '=', 'processing')
    .where(
      'processing_started_at',
      '<',
      sql<string>`NOW() - (${thresholdMinutes} || ' minutes')::interval`,
    )
    .execute();
  return rows.map((r) => toKbDocument(r as Record<string, unknown>));
}
