import { createHash } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { parseQuery } from '@/lib/middleware/validate';
import { getDefaultAccountId } from '@/lib/queries-accounts';
import { getKbDocumentBySha256, insertKbDocument, listKbDocuments } from '@/lib/queries-kb';
import { embedAndUpsertChunks, writeKbFile } from '@/lib/rag/kb-ingest';
import { reconcileOnce } from '@/lib/rag/kb-reconciler';
import {
  KB_MAX_FILE_BYTES,
  kbFilenameSchema,
  kbListQuerySchema,
  kbMimeTypeSchema,
} from '@/lib/schemas/kb';

export const dynamic = 'force-dynamic';

// STAQPRO-148 — operator-facing knowledge base routes (basic_auth gated by
// Caddy; not under /api/internal). The HTTP layer is intentionally thin —
// all the parser / chunker / embed / Qdrant / status-machine logic lives
// in lib/rag/kb-* (validated by scripts/kb-smoke.ts).
//
// POST /api/kb-documents
//   multipart/form-data: file (required), title (optional)
//   - sha256s the bytes
//   - dedupes on sha256: returns 200 with {duplicate: true, doc_id} if the
//     same content was already uploaded (no second row, no re-embed)
//   - writes file → inserts row (status=processing) → fire-and-forget embed
//   - returns 200 with {doc_id, status: 'processing', duplicate: false}
//
// GET /api/kb-documents?status=ready&limit=200
//   - lazy reconciler boot hook (flips stuck 'processing' rows older than
//     5 min to 'failed' once per process lifetime)
//   - returns {documents: KbDocument[]}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (error) {
    return NextResponse.json(
      {
        error: 'invalid_multipart',
        message: error instanceof Error ? error.message : 'failed to parse multipart body',
      },
      { status: 400 },
    );
  }

  const fileEntry = form.get('file');
  if (!(fileEntry instanceof File)) {
    return NextResponse.json(
      { error: 'missing_file', message: 'multipart field "file" is required' },
      { status: 400 },
    );
  }

  // Filename validation. Reject path separators / null bytes early — the on-
  // disk path is sha256-keyed so the operator-supplied filename is metadata
  // only, but we still want to reject obviously hostile inputs.
  const filenameParse = kbFilenameSchema.safeParse(fileEntry.name);
  if (!filenameParse.success) {
    return NextResponse.json(
      {
        error: 'invalid_filename',
        message: filenameParse.error.issues.map((i) => i.message).join('; '),
      },
      { status: 400 },
    );
  }
  const filename = filenameParse.data;

  const mimeParse = kbMimeTypeSchema.safeParse(fileEntry.type);
  if (!mimeParse.success) {
    return NextResponse.json(
      {
        error: 'unsupported_mime_type',
        message: mimeParse.error.issues.map((i) => i.message).join('; '),
        received: fileEntry.type || '(empty)',
      },
      { status: 400 },
    );
  }
  const mime_type = mimeParse.data;

  const arrayBuffer = await fileEntry.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.byteLength === 0) {
    return NextResponse.json(
      { error: 'empty_file', message: 'uploaded file is 0 bytes' },
      { status: 400 },
    );
  }
  if (buffer.byteLength > KB_MAX_FILE_BYTES) {
    return NextResponse.json(
      {
        error: 'file_too_large',
        message: `file is ${buffer.byteLength} bytes; max is ${KB_MAX_FILE_BYTES}`,
      },
      { status: 413 },
    );
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');

  try {
    // MBOX-400 (MBOX-162 V7) — which inbox this document belongs to. Optional
    // multipart field; falls back to the default account so single-account
    // uploads (and the current UI, which doesn't yet send it) are unchanged.
    // The account picker (KB-3 UI) will start sending it.
    const accountIdRaw = form.get('account_id');
    const parsedAccountId = accountIdRaw != null ? Number(accountIdRaw) : Number.NaN;
    const accountId =
      Number.isInteger(parsedAccountId) && parsedAccountId > 0
        ? parsedAccountId
        : await getDefaultAccountId();

    // Idempotency-by-content: re-upload of the same bytes returns the
    // existing row. Per-account (MBOX-400) — the same file can live in two
    // inboxes. Operator-facing 200 with duplicate:true (not a 409 —
    // duplicate uploads are a normal "I clicked twice" UX, not an error).
    const existing = await getKbDocumentBySha256(sha256, accountId);
    if (existing) {
      return NextResponse.json({
        ok: true,
        duplicate: true,
        doc_id: existing.id,
        status: existing.status,
        sha256,
      });
    }

    const ext = filename.includes('.') ? (filename.split('.').pop() ?? 'bin') : 'bin';
    await writeKbFile(sha256, ext, buffer);

    const titleFromForm = (form.get('title') as string | null)?.trim();
    const doc = await insertKbDocument({
      account_id: accountId,
      title: titleFromForm && titleFromForm.length > 0 ? titleFromForm : filename,
      filename,
      mime_type,
      size_bytes: buffer.byteLength,
      sha256,
      uploaded_by: (form.get('uploaded_by') as string | null) ?? null,
    });

    // Fire-and-forget embed pipeline. The kb-reconciler hook on subsequent
    // GET list calls catches anything stuck in 'processing' > 5 min if this
    // process dies mid-embed.
    void embedAndUpsertChunks(doc.id).catch((err) => {
      console.error(`[kb-documents] embed pipeline threw for doc ${doc.id}:`, err);
    });

    return NextResponse.json({
      ok: true,
      duplicate: false,
      doc_id: doc.id,
      status: doc.status,
      sha256,
    });
  } catch (error) {
    console.error('POST /api/kb-documents failed:', error);
    return NextResponse.json(
      {
        error: 'upload_failed',
        message: error instanceof Error ? error.message : 'unknown',
      },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Lazy boot hook for the reconciler. Idempotent + once-per-process.
  // Any error inside is logged + swallowed by reconcileOnce — never
  // blocks the list response.
  await reconcileOnce();

  const queryParse = parseQuery(req, kbListQuerySchema);
  if (!queryParse.ok) return queryParse.response;

  try {
    const documents = await listKbDocuments(queryParse.data);
    return NextResponse.json({ documents });
  } catch (error) {
    console.error('GET /api/kb-documents failed:', error);
    return NextResponse.json(
      {
        error: 'list_failed',
        message: error instanceof Error ? error.message : 'unknown',
      },
      { status: 500 },
    );
  }
}
