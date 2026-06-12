import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { idParamSchema } from '@/lib/schemas/common';
import { undoRejectBodySchema } from '@/lib/schemas/drafts';

export const dynamic = 'force-dynamic';

// STAQPRO-331 #9 — operator-initiated undo of a fresh reject. The toast
// in QueueClient surfaces this for ~5s after a reject lands. Flips
// rejected → pending and removes the LATEST draft_feedback row only
// (preserves any earlier rejection-cycle feedback so the audit chain
// through multi-cycle drafts stays intact).
//
// Audit GUCs (mailbox.actor='operator', mailbox.transition_reason='undo_reject')
// are set inside the same transaction BEFORE the UPDATE so the migration-009
// AFTER UPDATE OF status trigger reads them. Mirrors the pattern in
// lib/transitions.ts:transitionToApprovedAndSend — kept inline here rather
// than extending that helper because the terminal state and audit reason
// are different.
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const b = await parseJson(req, undoRejectBodySchema);
  if (!b.ok) return b.response;

  try {
    const db = getKysely();
    const result = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('mailbox.actor', 'operator', true)`.execute(trx);
      await sql`SELECT set_config('mailbox.transition_reason', 'undo_reject', true)`.execute(trx);

      const flipped = await trx
        .updateTable('drafts')
        .set({ status: 'pending', updated_at: sql<string>`NOW()` })
        .where('id', '=', id)
        .where('status', '=', 'rejected')
        .returning(['id', 'status'])
        .execute();
      if (flipped.length === 0) return null;

      // Delete the LATEST feedback row for this draft only. Subquery selects
      // the most recent row by rejected_at; preserves any earlier rejection-
      // cycle feedback so multi-cycle audit history stays intact.
      await trx
        .deleteFrom('draft_feedback')
        .where(({ eb, selectFrom }) =>
          eb(
            'id',
            'in',
            selectFrom('draft_feedback')
              .select('id')
              .where('draft_id', '=', id)
              .orderBy('rejected_at', 'desc')
              .limit(1),
          ),
        )
        .execute();
      return flipped[0];
    });
    if (result === null) {
      return NextResponse.json({ error: 'Draft not in rejected state' }, { status: 409 });
    }
    return NextResponse.json({ success: true, draft: result });
  } catch (error) {
    console.error(`POST /api/drafts/${id}/undo-reject failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
