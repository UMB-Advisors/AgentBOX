// dashboard/lib/queries-operator-settings.ts
//
// MBOX-162 P4 — singleton-row queries for mailbox.operator_settings. Holds the
// operator's right-pane Calendar/Drive embed config + scheduling link. Mirrors
// the lib/queries-system-state.ts singleton pattern (one row, id=1, seeded by
// migration 037 so reads never miss).

import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import type { OperatorSettings } from '@/lib/types';

const EMPTY: OperatorSettings = {
  booking_link: '',
  calendar_embed_src: '',
  drive_folder_id: '',
};

// Reads the singleton row. Falls back to all-empty defaults if the seed row is
// somehow missing (defensive — migration 037 seeds it), so callers can always
// render without a null check.
export async function getOperatorSettings(): Promise<OperatorSettings> {
  const db = getKysely();
  const row = await db
    .selectFrom('operator_settings')
    .select(['booking_link', 'calendar_embed_src', 'drive_folder_id'])
    .where('id', '=', 1)
    .executeTakeFirst();
  if (!row) return { ...EMPTY };
  return {
    booking_link: row.booking_link,
    calendar_embed_src: row.calendar_embed_src,
    drive_folder_id: row.drive_folder_id,
  };
}

// Full replace of the three operator-editable fields (PUT semantics). Caller
// passes already-validated, trimmed values (zod transform in
// lib/schemas/operator-settings.ts). Upserts the singleton so a missing seed
// row self-heals. Returns the persisted shape.
export async function updateOperatorSettings(input: OperatorSettings): Promise<OperatorSettings> {
  const db = getKysely();
  const row = await db
    .insertInto('operator_settings')
    .values({
      id: 1,
      booking_link: input.booking_link,
      calendar_embed_src: input.calendar_embed_src,
      drive_folder_id: input.drive_folder_id,
      updated_at: sql<string>`NOW()`,
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet((eb) => ({
        booking_link: eb.ref('excluded.booking_link'),
        calendar_embed_src: eb.ref('excluded.calendar_embed_src'),
        drive_folder_id: eb.ref('excluded.drive_folder_id'),
        updated_at: sql<string>`NOW()`,
      })),
    )
    .returning(['booking_link', 'calendar_embed_src', 'drive_folder_id'])
    .executeTakeFirstOrThrow();
  return {
    booking_link: row.booking_link,
    calendar_embed_src: row.calendar_embed_src,
    drive_folder_id: row.drive_folder_id,
  };
}
