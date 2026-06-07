import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { idParamSchema } from '@/lib/schemas/common';
import { actionItemsBodySchema } from '@/lib/schemas/drafts';

export const dynamic = 'force-dynamic';

// MBOX-131 — operator edit of a draft's structured action items. Body:
// { action_items: ActionItem[] } (zod-validated, enums anchored to the
// canonical tuples). POST (not PATCH) to mirror the rest of the drafts CRUD
// mutation surface (edit / approve / reject all POST).
//
// Persists the full replacement array (the client owns add/edit/delete and
// posts the resulting list). Wrapped in a transaction that SETs the
// mailbox.actor / mailbox.transition_reason GUCs per the established
// attribution convention (lib/transitions.ts, the classification-override
// route). NOTE: the migration-009 state_transitions trigger fires only on a
// drafts.status change — an action_items-only edit does not touch status, so
// it emits no state_transitions row by design (same as the classification
// override). The GUCs are set anyway so attribution is correct if any future
// status-touching write ever joins this transaction.
const TRANSITION_REASON = 'edit_action_items';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const b = await parseJson(req, actionItemsBodySchema);
  if (!b.ok) return b.response;
  const { action_items } = b.data;

  try {
    const db = getKysely();
    const result = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('mailbox.actor', 'operator', true)`.execute(trx);
      await sql`SELECT set_config('mailbox.transition_reason', ${TRANSITION_REASON}, true)`.execute(
        trx,
      );

      const rows = await trx
        .updateTable('drafts')
        .set({
          action_items: sql`${JSON.stringify(action_items)}::jsonb`,
          updated_at: sql<string>`NOW()`,
        })
        .where('id', '=', id)
        .returning(['id', 'action_items', 'updated_at'])
        .execute();
      return rows[0] ?? null;
    });

    if (result === null) {
      return NextResponse.json({ error: 'draft_not_found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, draft: result });
  } catch (error) {
    console.error(`POST /api/drafts/${id}/action-items failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
