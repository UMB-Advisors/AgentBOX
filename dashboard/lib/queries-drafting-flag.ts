// MBOX-288 (DR-54 / §7.11.3) — live read for the honest in-flight "drafting"
// flag. Reads ONLY existing tables (mailbox.drafts + mailbox.state_transitions
// per §8); no migration. Fail-closed like queries-system.ts: on any error we
// return the NOT-drafting flag rather than throwing, so a transient DB blip can
// never surface a phantom "drafting an email" claim (SM-72).

import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import {
  DRAFTING_IN_FLIGHT_STATUSES,
  type DraftingFlag,
  deriveDraftingFlag,
  type InFlightDraftRow,
} from '@/lib/drafting-flag';

// Defensive cap — there should only ever be a handful of in-flight stubs at
// once (the pipeline drafts serially), but bound the read so a pathological
// backlog can't pull the whole table into memory.
const MAX_IN_FLIGHT_ROWS = 25;

/**
 * Derive the honest drafting flag from live pipeline state.
 *
 * The query selects only genuinely-in-flight stubs:
 *   - status IN ('pending','awaiting_cloud')  (the in-flight statuses)
 *   - draft_body = ''                          (stub not yet finalized by
 *                                               /api/internal/draft-finalize)
 *
 * A finalized-but-unapproved draft (status='pending', non-empty body) is
 * deliberately excluded — it's awaiting operator approval, not drafting.
 *
 * `since` is the most recent mailbox.state_transitions.transitioned_at for the
 * draft (the §8 audit log — source of truth for "what changed when"), with the
 * row's own created_at/updated_at as a fallback when no transition has been
 * logged yet (a brand-new stub before its first status write).
 *
 * Ordered by id ASC so the oldest in-flight stub — the one the pipeline is
 * most likely actively working — is the natural pick; deriveDraftingFlag()
 * re-derives the oldest defensively regardless of order.
 */
export async function getDraftingFlag(): Promise<DraftingFlag> {
  try {
    const db = getKysely();
    const rows = await db
      .selectFrom('drafts')
      .select([
        'drafts.id',
        'drafts.status',
        'drafts.draft_body',
        'drafts.from_addr',
        'drafts.subject',
        // Latest transition timestamp from the append-only audit log, falling
        // back to the row's own timestamps. COALESCE keeps `since` non-null in
        // practice (created_at is NOT NULL) so the UI always has an honest
        // start time.
        sql<string>`COALESCE(
          (SELECT st.transitioned_at
             FROM mailbox.state_transitions st
            WHERE st.draft_id = drafts.id
            ORDER BY st.transitioned_at DESC
            LIMIT 1),
          drafts.updated_at,
          drafts.created_at
        )`.as('since'),
      ])
      .where('drafts.status', 'in', DRAFTING_IN_FLIGHT_STATUSES as readonly string[])
      .where(sql<boolean>`COALESCE(TRIM(drafts.draft_body), '') = ''`)
      .orderBy('drafts.id', 'asc')
      .limit(MAX_IN_FLIGHT_ROWS)
      .execute();

    return deriveDraftingFlag(rows as InFlightDraftRow[]);
  } catch (error) {
    console.error('getDraftingFlag failed:', error);
    // Fail closed: when we can't read live state, make NO drafting claim.
    return { drafting: false };
  }
}
