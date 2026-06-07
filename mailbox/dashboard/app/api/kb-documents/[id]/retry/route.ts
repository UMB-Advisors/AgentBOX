import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseParams } from '@/lib/middleware/validate';
import { getKbDocument } from '@/lib/queries-kb';
import { embedAndUpsertChunks } from '@/lib/rag/kb-ingest';
import { kbIdParamSchema } from '@/lib/schemas/kb';

export const dynamic = 'force-dynamic';

// STAQPRO-148 — Retry the embed pipeline against an already-uploaded doc.
// Two valid sources:
//   1. status='failed' — embed pipeline errored, operator clicks Retry
//   2. status='processing' — flagged stuck by the kb-reconciler then later
//      cleared OR the operator wants to force-restart an in-flight job
// Any other status (ready) is a 409 — the doc is already indexed; deleting +
// re-uploading is the path for re-processing a ready doc.
//
// Resets status='processing' + processing_started_at=NOW() + clears
// error_message, then fires the embed pipeline. The original sha256-keyed
// file is still on disk (Commit 2's design decision: keep originals to
// enable Retry without re-upload).

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const params = await ctx.params;
  const parsed = parseParams(params, kbIdParamSchema);
  if (!parsed.ok) return parsed.response;
  const { id } = parsed.data;

  try {
    const doc = await getKbDocument(id);
    if (!doc) {
      return NextResponse.json({ error: 'not_found', doc_id: id }, { status: 404 });
    }
    if (doc.status === 'ready') {
      return NextResponse.json(
        {
          error: 'already_ready',
          message: 'doc is already indexed; delete and re-upload to re-process',
          doc_id: id,
        },
        { status: 409 },
      );
    }

    const db = getKysely();
    await db
      .updateTable('kb_documents')
      .set({
        status: 'processing',
        processing_started_at: sql<string>`NOW()`,
        error_message: null,
      })
      .where('id', '=', id)
      .execute();

    void embedAndUpsertChunks(id).catch((err) => {
      console.error(`[kb-documents retry] embed pipeline threw for doc ${id}:`, err);
    });

    return NextResponse.json({ retrying: true, doc_id: id });
  } catch (error) {
    console.error(`POST /api/kb-documents/${id}/retry failed:`, error);
    return NextResponse.json(
      { error: 'retry_failed', message: error instanceof Error ? error.message : 'unknown' },
      { status: 500 },
    );
  }
}
