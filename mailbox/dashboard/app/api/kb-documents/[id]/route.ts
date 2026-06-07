import path from 'node:path';
import { type NextRequest, NextResponse } from 'next/server';
import { parseParams } from '@/lib/middleware/validate';
import { deleteKbDocument, getKbDocument } from '@/lib/queries-kb';
import { deleteKbFile } from '@/lib/rag/kb-ingest';
import { deleteKbPointsByDocId } from '@/lib/rag/kb-qdrant';
import { kbIdParamSchema } from '@/lib/schemas/kb';

export const dynamic = 'force-dynamic';

// STAQPRO-148 — per-document detail + cascade delete.
//
// GET  /api/kb-documents/[id]   → { document: KbDocument } | 404
// DELETE /api/kb-documents/[id] → cascade deletes Qdrant points (by doc_id
//                                  payload filter), then DB row, then the
//                                  sha256-keyed file on disk. Returns
//                                  { deleted: true, doc_id, sha256 } | 404.
//
// Cascade order: Qdrant first, DB second, FS last.
//   - If Qdrant fails: DB row + file remain → operator can Retry the delete
//     (idempotent on Qdrant side: deleting a doc with no points is a no-op).
//   - If DB fails: Qdrant points are gone (re-running the delete returns
//     404; the dangling state is invisible to operator since the row is
//     still listed). Acceptable — re-Retry will succeed.
//   - If FS fails: DB row + Qdrant points are gone; file lingers. The
//     nightly orphan sweep (deferred to Commit 5) reclaims it.
//
// Drafts that cited this doc keep their drafts.kb_context_refs intact
// (UUIDs in JSONB, no FK). Per the design decision: dangling refs render
// as "[deleted document]" in the UI, preserving audit trail.

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const params = await ctx.params;
  const parsed = parseParams(params, kbIdParamSchema);
  if (!parsed.ok) return parsed.response;
  const { id } = parsed.data;

  try {
    const document = await getKbDocument(id);
    if (!document) {
      return NextResponse.json({ error: 'not_found', doc_id: id }, { status: 404 });
    }
    return NextResponse.json({ document });
  } catch (error) {
    console.error(`GET /api/kb-documents/${id} failed:`, error);
    return NextResponse.json(
      { error: 'fetch_failed', message: error instanceof Error ? error.message : 'unknown' },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const params = await ctx.params;
  const parsed = parseParams(params, kbIdParamSchema);
  if (!parsed.ok) return parsed.response;
  const { id } = parsed.data;

  try {
    const doc = await getKbDocument(id);
    if (!doc) {
      return NextResponse.json({ error: 'not_found', doc_id: id }, { status: 404 });
    }

    const qdrantResult = await deleteKbPointsByDocId(id);
    if (!qdrantResult.ok) {
      // Surface to operator so they can Retry. DB row + file untouched.
      return NextResponse.json(
        {
          error: 'qdrant_delete_failed',
          message: qdrantResult.reason ?? 'unknown',
          doc_id: id,
        },
        { status: 502 },
      );
    }

    await deleteKbDocument(id);

    // FS cleanup last — best-effort. fs.rm with force:true never throws on
    // missing files (matches kb-ingest.deleteKbFile semantics).
    const ext = path.extname(doc.filename).replace(/^\.+/, '') || 'bin';
    await deleteKbFile(doc.sha256, ext);

    return NextResponse.json({ deleted: true, doc_id: id, sha256: doc.sha256 });
  } catch (error) {
    console.error(`DELETE /api/kb-documents/${id} failed:`, error);
    return NextResponse.json(
      { error: 'delete_failed', message: error instanceof Error ? error.message : 'unknown' },
      { status: 500 },
    );
  }
}
