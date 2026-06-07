import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { idParamSchema } from '@/lib/schemas/common';
import { editBodySchema } from '@/lib/schemas/drafts';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const b = await parseJson(req, editBodySchema);
  if (!b.ok) return b.response;
  const { draft_body, draft_subject } = b.data;

  try {
    const db = getKysely();
    const rows = await db
      .updateTable('drafts')
      .set({
        draft_body,
        draft_subject,
        status: 'edited',
        // STAQPRO-121: snapshot the LLM's original body before the first
        // edit overwrites it, so migration 010's archive trigger has a real
        // pre-edit pair to write into sent_history.draft_original. Only
        // populate on first edit (COALESCE keeps prior value); subsequent
        // edits preserve the FIRST snapshot — that's the true LLM-original.
        original_draft_body: sql<string>`COALESCE(original_draft_body, draft_body)`,
        updated_at: sql<string>`NOW()`,
      })
      .where('id', '=', id)
      .where('status', 'in', ['pending', 'edited'])
      .returning(['id', 'status', 'draft_body', 'draft_subject', 'updated_at'])
      .execute();
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Draft not in pending or edited state' }, { status: 409 });
    }
    return NextResponse.json({ success: true, draft: rows[0] });
  } catch (error) {
    console.error(`POST /api/drafts/${id}/edit failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
