import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { idParamSchema } from '@/lib/schemas/common';
import { rejectBodySchema } from '@/lib/schemas/drafts';

export const dynamic = 'force-dynamic';

// STAQPRO-331 #1 — structured reject feedback. Body: { reason_code, free_text? }.
// On success: status flips to 'rejected' AND one mailbox.draft_feedback row is
// inserted in the same transaction. drafts.error_message is NO LONGER written
// here (that column is for send-side Gmail Reply failures per CLAUDE.md state
// machine).
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const b = await parseJson(req, rejectBodySchema);
  if (!b.ok) return b.response;
  const { reason_code, free_text } = b.data;

  try {
    const db = getKysely();
    const result = await db.transaction().execute(async (trx) => {
      const flipped = await trx
        .updateTable('drafts')
        .set({
          status: 'rejected',
          updated_at: sql<string>`NOW()`,
        })
        .where('id', '=', id)
        .where('status', 'in', ['pending', 'edited'])
        .returning(['id', 'status'])
        .execute();
      if (flipped.length === 0) return null;
      await trx
        .insertInto('draft_feedback')
        .values({
          draft_id: id,
          reason_code,
          free_text,
        })
        .execute();
      return flipped[0];
    });
    if (result === null) {
      return NextResponse.json({ error: 'Draft not in pending or edited state' }, { status: 409 });
    }
    return NextResponse.json({ success: true, draft: result });
  } catch (error) {
    console.error(`POST /api/drafts/${id}/reject failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
