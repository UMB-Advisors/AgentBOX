import { sql } from 'kysely';
import { getKysely } from '@/lib/db';

// MBOX-133: read/write operator filter+sort preferences keyed by a dotted
// namespace ('queue.filters', 'queue.sort'). Single-operator-per-appliance for
// now — operator_id is NULL and the partial unique index
// (user_filter_preferences_default_key_uidx) makes it one-row-per-key.

export interface UserFilterPreference {
  key: string;
  value: unknown;
  updated_at: string;
}

// Reads the single-operator (operator_id IS NULL) row for a key. Returns null
// when nothing's been persisted yet — the route maps that to a 404 so the
// client falls back to its localStorage default.
export async function getPreference(key: string): Promise<UserFilterPreference | null> {
  const db = getKysely();
  const row = await db
    .selectFrom('user_filter_preferences')
    .select(['key', 'value', 'updated_at'])
    .where('key', '=', key)
    .where('operator_id', 'is', null)
    .executeTakeFirst();
  return (row as UserFilterPreference | undefined) ?? null;
}

// Upserts the single-operator row for a key. The ON CONFLICT target is the
// partial unique index on (key) WHERE operator_id IS NULL, so the matching
// `.where('operator_id','is',null)` clause is required for Postgres to pick it.
export async function upsertPreference(
  key: string,
  value: Record<string, unknown> | unknown[],
): Promise<UserFilterPreference> {
  const db = getKysely();
  // pg stringifies a JS object into a JSONB param; JSON.stringify mirrors the
  // persona-upsert convention so the round-trip stays byte-stable.
  const json = JSON.stringify(value);
  const row = await db
    .insertInto('user_filter_preferences')
    .values({
      operator_id: null,
      key,
      value: sql`${json}::jsonb`,
      updated_at: sql<string>`NOW()`,
    })
    .onConflict((oc) =>
      oc
        .columns(['key'])
        .where('operator_id', 'is', null)
        .doUpdateSet((eb) => ({
          value: eb.ref('excluded.value'),
          updated_at: sql<string>`NOW()`,
        })),
    )
    .returning(['key', 'value', 'updated_at'])
    .executeTakeFirstOrThrow();
  return row as UserFilterPreference;
}
