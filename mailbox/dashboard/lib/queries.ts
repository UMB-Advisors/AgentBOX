import { type RawBuilder, type SqlBool, sql } from 'kysely';
import { jsonBuildObject } from 'kysely/helpers/postgres';
import { getKysely, normalizeDraftBody } from '@/lib/db';
import { getThreadHistory, getThreadHistoryBatch } from '@/lib/queries-thread';
import {
  type ClassificationCategory,
  type DraftStatus,
  type DraftWithMessage,
  URGENCY_SIGNALS,
  type UrgencySignal,
} from '@/lib/types';
import { ageThresholdHours, LOW_CONF_FLOOR } from '@/lib/urgency';

// Re-exported for callers that previously imported VALID_STATUSES from here.
// STAQPRO-137 moved the canonical const to lib/types.ts so all consumers
// (queries, schemas, future migrations) read from one place.
export { DRAFT_STATUSES as VALID_STATUSES } from '@/lib/types';

// Both helpers select all draft columns plus an inline {message: InboxMessage}
// JSON object built from the joined inbox_messages row. kysely's
// jsonBuildObject helper compiles to the same Postgres json_build_object()
// call the original SQL used.

export async function listDrafts(
  statuses: DraftStatus[] = ['pending'],
  limit = 50,
  // MBOX-360 (MBOX-162 V3) — optional account filter for the unified queue.
  // When set, narrows to one connected inbox; omitted = all accounts.
  accountId?: number,
): Promise<DraftWithMessage[]> {
  const db = getKysely();
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  const rows = await db
    .selectFrom('drafts as d')
    .innerJoin('inbox_messages as m', 'd.inbox_message_id', 'm.id')
    .innerJoin('accounts as a', 'a.id', 'd.account_id')
    .where('d.status', 'in', statuses)
    .$if(accountId !== undefined, (qb) => qb.where('d.account_id', '=', accountId as number))
    // MBOX-369 — exclude rows disposed of by a per-row Gmail action.
    .where((eb) => eb(activeQueuePredicate(), '=', true))
    .selectAll('d')
    .select((eb) =>
      jsonBuildObject({
        id: eb.ref('m.id'),
        message_id: eb.ref('m.message_id'),
        thread_id: eb.ref('m.thread_id'),
        from_addr: eb.ref('m.from_addr'),
        to_addr: eb.ref('m.to_addr'),
        subject: eb.ref('m.subject'),
        received_at: eb.ref('m.received_at'),
        snippet: eb.ref('m.snippet'),
        body: eb.ref('m.body'),
        classification: eb.ref('m.classification'),
        confidence: eb.ref('m.confidence'),
        classified_at: eb.ref('m.classified_at'),
        model: eb.ref('m.model'),
        created_at: eb.ref('m.created_at'),
        draft_id: eb.ref('m.draft_id'),
        archived_at: eb.ref('m.archived_at'),
        deleted_at: eb.ref('m.deleted_at'),
        snooze_until: eb.ref('m.snooze_until'),
        is_read: eb.ref('m.is_read'),
        gmail_action_state: eb.ref('m.gmail_action_state'),
      }).as('message'),
    )
    .select((eb) =>
      jsonBuildObject({
        id: eb.ref('a.id'),
        email_address: eb.ref('a.email_address'),
        display_label: eb.ref('a.display_label'),
      }).as('account'),
    )
    .orderBy('d.created_at', 'desc')
    .limit(safeLimit)
    .execute();
  const drafts = rows.map((row) => {
    const r = row as unknown as DraftWithMessage;
    return { ...r, draft_body: normalizeDraftBody(r.draft_body) };
  });
  const histories = await getThreadHistoryBatch(
    drafts.map((d) => ({ threadId: d.message.thread_id, excludeInboxMessageId: d.message.id })),
  );
  const withHistory = drafts.map((d, i) => ({ ...d, thread_history: histories[i] }));
  return withHistory;
}

export async function getDraft(id: number): Promise<DraftWithMessage | null> {
  const db = getKysely();
  const row = await db
    .selectFrom('drafts as d')
    .innerJoin('inbox_messages as m', 'd.inbox_message_id', 'm.id')
    .where('d.id', '=', id)
    .selectAll('d')
    .select((eb) =>
      jsonBuildObject({
        id: eb.ref('m.id'),
        message_id: eb.ref('m.message_id'),
        thread_id: eb.ref('m.thread_id'),
        from_addr: eb.ref('m.from_addr'),
        to_addr: eb.ref('m.to_addr'),
        subject: eb.ref('m.subject'),
        received_at: eb.ref('m.received_at'),
        snippet: eb.ref('m.snippet'),
        body: eb.ref('m.body'),
        classification: eb.ref('m.classification'),
        confidence: eb.ref('m.confidence'),
        classified_at: eb.ref('m.classified_at'),
        model: eb.ref('m.model'),
        created_at: eb.ref('m.created_at'),
        draft_id: eb.ref('m.draft_id'),
        archived_at: eb.ref('m.archived_at'),
        deleted_at: eb.ref('m.deleted_at'),
        snooze_until: eb.ref('m.snooze_until'),
        is_read: eb.ref('m.is_read'),
        gmail_action_state: eb.ref('m.gmail_action_state'),
      }).as('message'),
    )
    .executeTakeFirst();
  if (!row) return null;
  const r = row as unknown as DraftWithMessage;
  const thread_history = await getThreadHistory(r.message.thread_id, r.message.id);
  return { ...r, draft_body: normalizeDraftBody(r.draft_body), thread_history };
}

// ── MBOX-134: urgency engine SQL surface ────────────────────────────────────
//
// getQueueWithUrgency + countUrgentDrafts compute the urgency signals
// (lib/urgency.ts) set-wise in Postgres so the dashboard never ships an N+1 of
// per-row evaluator calls. The rule SoT is lib/urgency.ts:evaluateUrgency; the
// SQL below mirrors it exactly:
//   - escalate : classification_category = 'escalate'
//   - vip      : sender matches mailbox.vip_senders (exact email OR
//                domain-suffix; NO regex)
//   - aged     : status = 'pending' AND age_hours > threshold(category)
//   - low_conf : classification_confidence IS NULL OR < LOW_CONF_FLOOR
// The per-category age thresholds are env-resolved in TS (ageThresholdHours)
// and baked into a CASE expression so the threshold logic stays in one place.

// All classification categories — kept local (rather than importing CATEGORIES
// from lib/classification/prompt to avoid pulling the prompt module into the
// query path). The CASE built from this drives the aged-threshold comparison.
const URGENCY_CATEGORIES: ClassificationCategory[] = [
  'inquiry',
  'reorder',
  'scheduling',
  'follow_up',
  'internal',
  'spam_marketing',
  'escalate',
  'unknown',
];

// Boolean SQL fragment: does this draft's sender match the VIP list? Exact
// email match on the full address, OR domain-suffix match (the part after '@',
// or the whole value if it's already bare). Both sides are lowercased — the
// VIP value is stored lowercased (zod transform) and the draft sender is
// lowercased here.
function vipMatchExpr(): RawBuilder<SqlBool> {
  return sql<SqlBool>`EXISTS (
    SELECT 1 FROM mailbox.vip_senders v
    WHERE (
      v.kind = 'email'
      AND v.email_or_domain = lower(d.from_addr)
    ) OR (
      v.kind = 'domain'
      AND lower(split_part(d.from_addr, '@', 2)) = v.email_or_domain
    )
  )`;
}

// MBOX-369 — boolean SQL fragment: is this row still "live" in the queue, i.e.
// NOT disposed of by a per-row Gmail action? Archived or trashed rows are
// hard-hidden; a snoozed row is hidden until snooze_until passes (then it
// resurfaces). is_read is deliberately NOT a filter here — marking read clears
// the unread dot but keeps the row in the queue (per MBOX-369 decision). Joined
// alias `m` (inbox_messages) must be in scope at the call site.
function activeQueuePredicate(): RawBuilder<SqlBool> {
  return sql<SqlBool>`(
    m.archived_at IS NULL
    AND m.deleted_at IS NULL
    AND (m.snooze_until IS NULL OR m.snooze_until <= NOW())
  )`;
}

// Boolean SQL fragment: is this draft aged past its category threshold while
// pending? The threshold (hours) is resolved per-category in TS and emitted as
// a CASE so the SQL stays a single set-based scan.
function agedMatchExpr(env: Record<string, string | undefined> = process.env): RawBuilder<SqlBool> {
  // Thresholds are code-controlled positive numbers (env-resolved + validated
  // in ageThresholdHours — a junk env value falls back to a default, never
  // reaches here as a string). Emit them as numeric literals (sql.lit) rather
  // than bound params so the CASE expression has a numeric type and the
  // `EXTRACT(...) > CASE` comparison stays numeric > numeric (a bound JS number
  // binds as text in a bare CASE, yielding `operator does not exist: numeric >
  // text`).
  const whenClauses = URGENCY_CATEGORIES.map(
    (c) => sql`WHEN ${sql.lit(c)} THEN ${sql.lit(ageThresholdHours(c, env))}`,
  );
  const defaultHours = ageThresholdHours(null, env);
  return sql<SqlBool>`(
    d.status = 'pending'
    AND EXTRACT(EPOCH FROM (NOW() - d.created_at)) / 3600.0 > (
      CASE d.classification_category
        ${sql.join(whenClauses, sql` `)}
        ELSE ${sql.lit(defaultHours)}
      END
    )
  )`;
}

interface UrgencyFlagsRow {
  is_escalate: boolean;
  is_vip: boolean;
  is_aged: boolean;
  is_low_conf: boolean;
}

// Assemble the ordered signals[] + urgent flag from the four boolean columns,
// preserving URGENCY_SIGNALS display priority (escalate → vip → aged →
// low_conf). Mirrors evaluateUrgency's push order so SQL and TS agree.
function signalsFromFlags(row: UrgencyFlagsRow): { urgent: boolean; signals: UrgencySignal[] } {
  const fired: Record<UrgencySignal, boolean> = {
    escalate: row.is_escalate,
    vip: row.is_vip,
    aged: row.is_aged,
    low_conf: row.is_low_conf,
  };
  const signals = URGENCY_SIGNALS.filter((s) => fired[s]);
  return { urgent: signals.length > 0, signals };
}

export interface DraftWithUrgency extends DraftWithMessage {
  urgency: { urgent: boolean; signals: UrgencySignal[] };
}

// Queue list with urgency signals computed in SQL. Same shape as listDrafts
// (draft + inline message + thread history) plus an `urgency` field. Defaults
// to the operator action list (pending + edited) — the queue folder.
export async function getQueueWithUrgency(
  statuses: DraftStatus[] = ['pending', 'edited'],
  limit = 50,
  env: Record<string, string | undefined> = process.env,
  // MBOX-162 V3 — when true, restrict to drafts firing ≥1 urgency signal
  // (the Priority / cross-account view). Same OR-of-signals predicate as
  // countUrgentDrafts, applied set-wise in SQL (no per-row evaluator pass).
  urgentOnly = false,
  // MBOX-360 (MBOX-162 V3) — optional account filter for the unified queue.
  accountId?: number,
): Promise<DraftWithUrgency[]> {
  const db = getKysely();
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  let query = db
    .selectFrom('drafts as d')
    .innerJoin('inbox_messages as m', 'd.inbox_message_id', 'm.id')
    .innerJoin('accounts as a', 'a.id', 'd.account_id')
    .where('d.status', 'in', statuses);
  if (accountId !== undefined) {
    query = query.where('d.account_id', '=', accountId);
  }
  // MBOX-369 — exclude disposed rows from the urgency / priority queue too.
  query = query.where((eb) => eb(activeQueuePredicate(), '=', true));
  if (urgentOnly) {
    query = query.where((eb) =>
      eb.or([
        eb(sql<boolean>`(d.classification_category = 'escalate')`, '=', true),
        eb(vipMatchExpr(), '=', true),
        eb(agedMatchExpr(env), '=', true),
        eb(
          sql<boolean>`(
            d.classification_confidence IS NULL
            OR d.classification_confidence < ${LOW_CONF_FLOOR}
          )`,
          '=',
          true,
        ),
      ]),
    );
  }
  const rows = await query
    .selectAll('d')
    .select((eb) =>
      jsonBuildObject({
        id: eb.ref('m.id'),
        message_id: eb.ref('m.message_id'),
        thread_id: eb.ref('m.thread_id'),
        from_addr: eb.ref('m.from_addr'),
        to_addr: eb.ref('m.to_addr'),
        subject: eb.ref('m.subject'),
        received_at: eb.ref('m.received_at'),
        snippet: eb.ref('m.snippet'),
        body: eb.ref('m.body'),
        classification: eb.ref('m.classification'),
        confidence: eb.ref('m.confidence'),
        classified_at: eb.ref('m.classified_at'),
        model: eb.ref('m.model'),
        created_at: eb.ref('m.created_at'),
        draft_id: eb.ref('m.draft_id'),
        archived_at: eb.ref('m.archived_at'),
        deleted_at: eb.ref('m.deleted_at'),
        snooze_until: eb.ref('m.snooze_until'),
        is_read: eb.ref('m.is_read'),
        gmail_action_state: eb.ref('m.gmail_action_state'),
      }).as('message'),
    )
    .select((eb) =>
      jsonBuildObject({
        id: eb.ref('a.id'),
        email_address: eb.ref('a.email_address'),
        display_label: eb.ref('a.display_label'),
      }).as('account'),
    )
    .select([
      sql<boolean>`(d.classification_category = 'escalate')`.as('is_escalate'),
      vipMatchExpr().as('is_vip'),
      agedMatchExpr(env).as('is_aged'),
      sql<boolean>`(
        d.classification_confidence IS NULL
        OR d.classification_confidence < ${LOW_CONF_FLOOR}
      )`.as('is_low_conf'),
    ])
    .orderBy('d.created_at', 'desc')
    .limit(safeLimit)
    .execute();

  const drafts = rows.map((row) => {
    const r = row as unknown as DraftWithMessage & UrgencyFlagsRow;
    return {
      ...r,
      draft_body: normalizeDraftBody(r.draft_body),
      urgency: signalsFromFlags(r),
    } as DraftWithUrgency;
  });

  const histories = await getThreadHistoryBatch(
    drafts.map((d) => ({ threadId: d.message.thread_id, excludeInboxMessageId: d.message.id })),
  );
  const withHistory = drafts.map((d, i) => ({ ...d, thread_history: histories[i] }));
  return withHistory;
}

// MBOX-162 V3 — the cross-account Priority view: every actionable draft
// (pending + edited) firing ≥1 urgency signal, across ALL connected accounts,
// each row carrying its `account` + `urgency`. One SQL pass (getQueueWithUrgency
// with urgentOnly), so it scales the same as the regular queue.
export async function getHighPriorityQueue(
  limit = 50,
  env: Record<string, string | undefined> = process.env,
  // MBOX-360 (MBOX-162 V3) — optional account filter for the unified queue.
  accountId?: number,
): Promise<DraftWithUrgency[]> {
  return getQueueWithUrgency(['pending', 'edited'], limit, env, true, accountId);
}

// Red-flag count for the dashboard header (GET /api/queue/urgent-count). Counts
// drafts in the queue slice (pending + edited) that fire at least one urgency
// signal — computed entirely in SQL (one COUNT, no row materialization).
export async function countUrgentDrafts(
  statuses: DraftStatus[] = ['pending', 'edited'],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const db = getKysely();
  const row = await db
    .selectFrom('drafts as d')
    // MBOX-369 — join inbox_messages so disposed rows (archived/trashed/snoozed)
    // don't inflate the urgent badge count.
    .innerJoin('inbox_messages as m', 'd.inbox_message_id', 'm.id')
    .where('d.status', 'in', statuses)
    .where((eb) => eb(activeQueuePredicate(), '=', true))
    .where((eb) =>
      eb.or([
        eb(sql<boolean>`(d.classification_category = 'escalate')`, '=', true),
        eb(vipMatchExpr(), '=', true),
        eb(agedMatchExpr(env), '=', true),
        eb(
          sql<boolean>`(
            d.classification_confidence IS NULL
            OR d.classification_confidence < ${LOW_CONF_FLOOR}
          )`,
          '=',
          true,
        ),
      ]),
    )
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
