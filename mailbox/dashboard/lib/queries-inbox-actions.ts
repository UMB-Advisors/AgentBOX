import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import type { GmailMsgAction } from '@/lib/n8n';

// MBOX-369 — DB surface for per-row Gmail queue actions (archive / delete /
// mark-read / snooze). Disposition state lives on mailbox.inbox_messages
// (migration 036). The route layer applies local state here, then (for the
// three write-through actions) fires the MailBOX-MsgAction n8n webhook and
// records the outcome via recordGmailActionState.
//
// Philosophy (mirrors the send path): the appliance DB is the source of truth;
// Gmail is a downstream side-effect. Local disposition is applied immediately
// (the row leaves the operator's queue); a Gmail write failure is recorded as
// gmail_action_state='failed' for observability/retry, NOT rolled back — same
// stance as approve→send not un-approving on a webhook 502.

// Minimal target after a local-state mutation — enough to fire the webhook.
export interface InboxActionTarget {
  id: number;
  account_id: number;
  message_id: string; // Gmail message id
}

const TARGET_COLS = ['id', 'account_id', 'message_id'] as const;

// Archive: hide from the queue + write-through to Gmail (removeLabelIds INBOX).
// Idempotent — re-archiving keeps the original archived_at (COALESCE). Returns
// null only when the message id doesn't exist.
export async function applyArchive(id: number): Promise<InboxActionTarget | null> {
  const db = getKysely();
  const row = await db
    .updateTable('inbox_messages')
    .set({
      archived_at: sql<string>`COALESCE(archived_at, NOW())`,
      gmail_action_state: 'pending',
    })
    .where('id', '=', id)
    .returning(TARGET_COLS)
    .executeTakeFirst();
  return row ?? null;
}

// Mark read: clear the unread dot locally + write-through to Gmail
// (removeLabelIds UNREAD). Row STAYS in the queue (MBOX-369 decision).
export async function applyMarkRead(id: number): Promise<InboxActionTarget | null> {
  const db = getKysely();
  const row = await db
    .updateTable('inbox_messages')
    .set({ is_read: true, gmail_action_state: 'pending' })
    .where('id', '=', id)
    .returning(TARGET_COLS)
    .executeTakeFirst();
  return row ?? null;
}

// Snooze: appliance-local only (Gmail has no snooze API). Hide until `until`
// passes, then the queue predicate resurfaces it. No Gmail write, so
// gmail_action_state is left untouched.
export async function applySnooze(id: number, until: string): Promise<InboxActionTarget | null> {
  const db = getKysely();
  const row = await db
    .updateTable('inbox_messages')
    .set({ snooze_until: until })
    .where('id', '=', id)
    .returning(TARGET_COLS)
    .executeTakeFirst();
  return row ?? null;
}

// Delete: trash in Gmail (messages.trash — recoverable) + discard any active
// linked draft (MBOX-369 decision: "delete discards the draft"). The draft flip
// runs in the same transaction with the actor/reason GUCs so the migration-009
// state_transitions trigger records actor='operator', reason='message_deleted'.
export async function applyDeleteAndRejectDraft(id: number): Promise<InboxActionTarget | null> {
  const db = getKysely();
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('mailbox.actor', 'operator', true)`.execute(trx);
    await sql`SELECT set_config('mailbox.transition_reason', 'message_deleted', true)`.execute(trx);

    const row = await trx
      .updateTable('inbox_messages')
      .set({
        deleted_at: sql<string>`COALESCE(deleted_at, NOW())`,
        gmail_action_state: 'pending',
      })
      .where('id', '=', id)
      .returning(TARGET_COLS)
      .executeTakeFirst();
    if (!row) return null;

    // Discard the active draft for this message (if any). Terminal/sent drafts
    // are left alone — we never un-send or touch history.
    await trx
      .updateTable('drafts')
      .set({ status: 'rejected', updated_at: sql<string>`NOW()` })
      .where('inbox_message_id', '=', id)
      .where('status', 'in', ['pending', 'awaiting_cloud', 'edited'])
      .execute();

    return row;
  });
}

// Record the Gmail write-through outcome after the webhook returns. 'ok' on
// success, 'failed' on a webhook error (row stays disposed locally — see
// philosophy note above). Best-effort: never throws into the caller.
export async function recordGmailActionState(id: number, state: 'ok' | 'failed'): Promise<void> {
  try {
    const db = getKysely();
    await db
      .updateTable('inbox_messages')
      .set({ gmail_action_state: state })
      .where('id', '=', id)
      .execute();
  } catch (err) {
    console.error(`recordGmailActionState(${id}, ${state}) failed:`, err);
  }
}

// Map the route action to the webhook's GmailMsgAction (snooze never reaches
// here — it's local-only). Kept beside the helpers so a new action can't be
// added in one place and forgotten in the other.
export const WRITE_THROUGH_ACTIONS: Record<'archive' | 'delete' | 'mark-read', GmailMsgAction> = {
  archive: 'archive',
  delete: 'delete',
  'mark-read': 'mark_read',
};
