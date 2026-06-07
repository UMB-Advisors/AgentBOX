import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import type { VipSenderKind } from '@/lib/types';

// MBOX-134: VIP sender list CRUD. Backs the urgency engine's 'vip' signal and
// the settings UI (dashboard/app/settings/vip). Match semantics are
// exact-email or domain-suffix — NO regex (the SQL match lives in
// getQueueWithUrgency / countUrgentDrafts in lib/queries.ts; this module is
// just the list management surface).

export interface VipSender {
  id: number;
  email_or_domain: string;
  kind: VipSenderKind;
  added_at: string;
  added_by: string | null;
  note: string | null;
}

export async function listVipSenders(): Promise<VipSender[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom('vip_senders')
    .select(['id', 'email_or_domain', 'kind', 'added_at', 'added_by', 'note'])
    .orderBy('added_at', 'desc')
    .execute();
  return rows as VipSender[];
}

// Idempotent insert. Re-adding the same (email_or_domain, kind) is a no-op
// upsert that refreshes the note (the operator may be editing it) — never a
// duplicate row (the partial unique index vip_senders_value_kind_uidx enforces
// this). Caller passes already-lowercased + validated values (zod transform in
// lib/schemas/vip.ts).
export async function upsertVipSender(input: {
  email_or_domain: string;
  kind: VipSenderKind;
  note: string | null;
  added_by?: string | null;
}): Promise<VipSender> {
  const db = getKysely();
  const row = await db
    .insertInto('vip_senders')
    .values({
      email_or_domain: input.email_or_domain,
      kind: input.kind,
      note: input.note,
      added_by: input.added_by ?? null,
      added_at: sql<string>`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(['email_or_domain', 'kind']).doUpdateSet((eb) => ({
        note: eb.ref('excluded.note'),
      })),
    )
    .returning(['id', 'email_or_domain', 'kind', 'added_at', 'added_by', 'note'])
    .executeTakeFirstOrThrow();
  return row as VipSender;
}

// Returns true when a row was deleted, false when the id didn't exist (the
// route maps the latter to a 404).
export async function deleteVipSender(id: number): Promise<boolean> {
  const db = getKysely();
  const res = await db.deleteFrom('vip_senders').where('id', '=', id).executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}
