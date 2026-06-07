import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { idParamSchema } from '@/lib/schemas/common';
import { classificationOverrideBodySchema } from '@/lib/schemas/drafts';

export const dynamic = 'force-dynamic';

// MBOX-123 — operator classification override. Body: { category, reason? }.
//
// v1 = RELABEL ONLY, no re-draft (open question from STAQPRO-403 resolved per
// the issue recommendation). The draft body is left untouched; if the override
// changes intent, the operator separately hits Reject or Edit. Re-draft on
// override is a deferred Phase 3 enhancement.
//
// Writes, all in ONE transaction so the audit trail is atomic:
//   1. mailbox.drafts.classification_category = <category>
//   2. mailbox.inbox_messages.classification = <category>   (denormalized
//      snapshot — also kept in sync by the migration-021 AFTER INSERT trigger
//      on classification_log; we write it explicitly per the MBOX-123
//      deliverable so the column is correct even if that trigger is ever
//      DISABLEd, and the value is identical so there's no drift)
//   3. APPEND mailbox.classification_log row (the source-of-truth audit record
//      for "what the classification changed to, when, and why"). model_version
//      = 'operator-override', confidence = 1.0, raw_output = operator reason.
//
// Audit attribution: the migration-009 mailbox.state_transitions trigger fires
// only on drafts.status changes — a relabel does NOT touch status, so it
// produces no state_transitions row (by design; classification history lives
// in classification_log, not state_transitions). We still SET LOCAL the
// mailbox.actor / mailbox.transition_reason GUCs inside the txn to mirror the
// established pattern (lib/transitions.ts) and to attribute correctly if any
// future status-touching write joins this transaction.
const OVERRIDE_MODEL_VERSION = 'operator-override';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const b = await parseJson(req, classificationOverrideBodySchema);
  if (!b.ok) return b.response;
  const { category, reason } = b.data;

  try {
    const db = getKysely();
    const result = await db.transaction().execute(async (trx) => {
      // Session-local GUCs (true = transaction-scoped). The state_transitions
      // trigger reads these; harmless for the classification path but keeps the
      // attribution convention uniform with approve/retry/undo-reject.
      await sql`SELECT set_config('mailbox.actor', 'operator', true)`.execute(trx);
      await sql`SELECT set_config('mailbox.transition_reason', 'manual-override', true)`.execute(
        trx,
      );

      // 1. Relabel the draft. Returning inbox_message_id so we can write the
      //    denorm column + the classification_log row. No status guard — an
      //    operator may relabel a draft in any state (a sent draft's category
      //    can still be corrected for the learning loop / analytics).
      const drafts = await trx
        .updateTable('drafts')
        .set({
          classification_category: category,
          updated_at: sql<string>`NOW()`,
        })
        .where('id', '=', id)
        .returning(['id', 'inbox_message_id'])
        .execute();
      if (drafts.length === 0) return null;
      const inboxMessageId = drafts[0].inbox_message_id;

      // 2. Denormalized snapshot on inbox_messages.
      await trx
        .updateTable('inbox_messages')
        .set({ classification: category })
        .where('id', '=', inboxMessageId)
        .execute();

      // 3. Append the audit record. confidence=1.0 (operator is certain),
      //    json_parse_ok=true (no model output to parse), raw_output carries
      //    the operator's reason. The migration-021 trigger on this INSERT
      //    re-syncs inbox_messages.{classification,confidence,classified_at,
      //    model} from this row — consistent with step 2.
      await trx
        .insertInto('classification_log')
        .values({
          inbox_message_id: inboxMessageId,
          category,
          confidence: 1.0,
          model_version: OVERRIDE_MODEL_VERSION,
          json_parse_ok: true,
          raw_output: reason,
        })
        .execute();

      return { id: drafts[0].id, inbox_message_id: inboxMessageId, category };
    });

    if (result === null) {
      return NextResponse.json({ error: 'draft_not_found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, draft: result });
  } catch (error) {
    console.error(`PATCH /api/drafts/${id}/classification failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
