import { sql } from 'kysely';
import type { AutoSendDecision, AutoSendEvalContext } from '@/lib/auto-send/rules';
import { getKysely } from '@/lib/db';
import type {
  AutoSendAction,
  AutoSendAuditEntry,
  AutoSendRule,
  ClassificationCategory,
} from '@/lib/types';

// MBOX-16 / FR-23 — data layer for auto-send rules + audit. The policy lives in
// lib/auto-send/rules.ts (pure); this module is the IO surface: rule CRUD for
// the operator UI, the enabled-rule loader the draft-finalize path feeds the
// evaluator, the per-draft eval-context loader, and the append-only audit
// writer.

// Minutes-from-midnight → "HH:MM" is a UI concern; the query layer round-trips
// the raw integer columns and lets the route map. We expose the AutoSendRule
// curated view verbatim.

const RULE_COLUMNS = [
  'id',
  'name',
  'enabled',
  'priority',
  'action',
  'category',
  'sender_domain',
  'min_confidence',
  'active_from_min',
  'active_to_min',
  'shadow_until',
  'created_at',
  'updated_at',
  'created_by',
] as const;

export async function listAutoSendRules(): Promise<AutoSendRule[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom('auto_send_rules')
    .select(RULE_COLUMNS)
    .orderBy('priority', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows as AutoSendRule[];
}

// The evaluator's input: enabled rules ONLY, in (priority ASC, id ASC) order —
// matching lib/auto-send/rules.ts:evaluateAutoSend's stop-on-first-match
// contract. The partial index auto_send_rules_enabled_priority_idx backs this.
export async function getEnabledAutoSendRules(): Promise<AutoSendRule[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom('auto_send_rules')
    .select(RULE_COLUMNS)
    .where('enabled', '=', true)
    .orderBy('priority', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows as AutoSendRule[];
}

export async function getAutoSendRule(id: number): Promise<AutoSendRule | null> {
  const db = getKysely();
  const row = await db
    .selectFrom('auto_send_rules')
    .select(RULE_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
  return (row as AutoSendRule | undefined) ?? null;
}

export interface AutoSendRuleInput {
  name: string;
  enabled: boolean;
  priority: number;
  action: AutoSendAction;
  category: ClassificationCategory | null;
  sender_domain: string | null;
  min_confidence: number | null;
  active_from_min: number | null;
  active_to_min: number | null;
  shadow_until: string | null;
  created_by?: string | null;
}

export async function createAutoSendRule(input: AutoSendRuleInput): Promise<AutoSendRule> {
  const db = getKysely();
  const row = await db
    .insertInto('auto_send_rules')
    .values({
      name: input.name,
      enabled: input.enabled,
      priority: input.priority,
      action: input.action,
      category: input.category,
      sender_domain: input.sender_domain,
      min_confidence: input.min_confidence,
      active_from_min: input.active_from_min,
      active_to_min: input.active_to_min,
      shadow_until: input.shadow_until,
      created_by: input.created_by ?? null,
      created_at: sql<string>`NOW()`,
      updated_at: sql<string>`NOW()`,
    })
    .returning(RULE_COLUMNS)
    .executeTakeFirstOrThrow();
  return row as AutoSendRule;
}

// Partial update. Only keys present in `patch` are written; passing `null`
// explicitly clears a condition column. Always bumps updated_at. Returns null
// when the id doesn't exist (route maps to 404).
export async function updateAutoSendRule(
  id: number,
  patch: Partial<Omit<AutoSendRuleInput, 'created_by'>>,
): Promise<AutoSendRule | null> {
  const db = getKysely();
  const row = await db
    .updateTable('auto_send_rules')
    .set({ ...patch, updated_at: sql<string>`NOW()` })
    .where('id', '=', id)
    .returning(RULE_COLUMNS)
    .executeTakeFirst();
  return (row as AutoSendRule | undefined) ?? null;
}

// Returns true when a row was deleted, false when the id didn't exist. Audit
// rows referencing the rule keep their snapshot (rule_id → NULL via ON DELETE
// SET NULL, rule_name preserved).
export async function deleteAutoSendRule(id: number): Promise<boolean> {
  const db = getKysely();
  const res = await db.deleteFrom('auto_send_rules').where('id', '=', id).executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}

// Per-draft evaluation context, joined from the draft row + its inbox message.
// category/confidence come from the draft denorm columns (set at stub insert,
// same columns the urgency SQL in lib/queries.ts reads); sender from the draft
// from_addr (mirrors vipMatchExpr). Returns null when the draft doesn't exist.
export async function getAutoSendEvalContext(draftId: number): Promise<AutoSendEvalContext | null> {
  const db = getKysely();
  const row = await db
    .selectFrom('drafts')
    .select([
      'classification_category',
      'classification_confidence',
      'from_addr',
      'auto_send_blocked',
    ])
    .where('id', '=', draftId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    category: row.classification_category as ClassificationCategory | null,
    confidence: row.classification_confidence,
    senderAddr: row.from_addr,
    autoSendBlocked: Boolean(row.auto_send_blocked),
  };
}

// Append one audit row for an auto-send evaluation (FR-23 §3). Never throws to
// the caller path on a logging failure — auto-send auditing is important but a
// transient audit-write failure must not block a draft from being queued.
export async function recordAutoSendAudit(
  draftId: number,
  decision: AutoSendDecision,
  reasonOverride?: string,
): Promise<void> {
  const db = getKysely();
  await db
    .insertInto('auto_send_audit')
    .values({
      draft_id: draftId,
      rule_id: decision.rule?.id ?? null,
      rule_name: decision.rule?.name ?? null,
      matched_action: decision.matchedAction,
      effective_action: decision.effectiveAction,
      shadow: decision.shadow,
      reason: reasonOverride ?? decision.reason,
      evaluated_at: sql<string>`NOW()`,
    })
    .execute();
}

export async function listAutoSendAuditForDraft(draftId: number): Promise<AutoSendAuditEntry[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom('auto_send_audit')
    .select([
      'id',
      'draft_id',
      'rule_id',
      'rule_name',
      'matched_action',
      'effective_action',
      'shadow',
      'reason',
      'evaluated_at',
    ])
    .where('draft_id', '=', draftId)
    .orderBy('evaluated_at', 'desc')
    .execute();
  return rows.map((r) => ({ ...r, id: Number(r.id) })) as AutoSendAuditEntry[];
}

// Mark a draft auto_send_blocked + reject it (the 'drop' action). Sets the
// state-transition GUCs so the migration-009 trigger attributes the reject to
// actor='auto'. Done in one txn so the block + status flip are atomic.
//
// Status guard covers every legal pre-send status — pending, awaiting_cloud,
// edited — kept in sync with the auto_send path's fromStates in
// lib/auto-send/finalize-hook.ts. An 'edited' draft matching a drop rule must
// be dropped, not silently no-op'd because the guard omitted its status.
export async function applyDropAction(draftId: number): Promise<void> {
  const db = getKysely();
  await db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('mailbox.actor', 'auto', true)`.execute(trx);
    await sql`SELECT set_config('mailbox.transition_reason', 'auto_send_rule_drop', true)`.execute(
      trx,
    );
    await trx
      .updateTable('drafts')
      .set({
        status: 'rejected',
        auto_send_blocked: true,
        updated_at: sql<string>`NOW()`,
      })
      .where('id', '=', draftId)
      .where('status', 'in', ['pending', 'awaiting_cloud', 'edited'])
      .execute();
  });
}
