import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import { getDefaultAccountId } from '@/lib/queries-accounts';
import type { PromptRuleScope } from '@/lib/types';

// MBOX-162 P5b (Tuning · Guidelines tab) — CRUD for mailbox.prompt_rules, the
// operator's drafting guidelines. Enabled rules are rendered into the system
// prompt by rulesSystemBlock (lib/drafting/prompt.ts); the settings UI manages
// the list. Account-scoped (the second multi-account dimension); every helper
// falls back to the seeded default account so single-account callers behave as
// before, mirroring lib/queries-persona.ts.

export interface PromptRule {
  id: number;
  scope: PromptRuleScope;
  rule: string;
  rationale: string;
  enabled: boolean;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = [
  'id',
  'scope',
  'rule',
  'rationale',
  'enabled',
  'version',
  'created_by',
  'created_at',
  'updated_at',
] as const;

// Full list for the settings UI, newest first.
export async function listPromptRules(accountId?: number): Promise<PromptRule[]> {
  const acct = accountId ?? (await getDefaultAccountId());
  const db = getKysely();
  const rows = await db
    .selectFrom('prompt_rules')
    .select(COLUMNS)
    .where('account_id', '=', acct)
    .orderBy('created_at', 'desc')
    .execute();
  return rows as PromptRule[];
}

// Draft-time read: only enabled rules, ordered for stable prompt rendering.
// Ordered by scope then id so the rendered block is deterministic for a given
// rule set (avoids spurious prompt churn between draft attempts).
export async function listEnabledPromptRules(accountId?: number): Promise<PromptRule[]> {
  const acct = accountId ?? (await getDefaultAccountId());
  const db = getKysely();
  const rows = await db
    .selectFrom('prompt_rules')
    .select(COLUMNS)
    .where('account_id', '=', acct)
    .where('enabled', '=', true)
    .orderBy('scope', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows as PromptRule[];
}

export async function createPromptRule(
  input: { scope: PromptRuleScope; rule: string; rationale: string; created_by?: string | null },
  accountId?: number,
): Promise<PromptRule> {
  const acct = accountId ?? (await getDefaultAccountId());
  const db = getKysely();
  const row = await db
    .insertInto('prompt_rules')
    .values({
      account_id: acct,
      scope: input.scope,
      rule: input.rule,
      rationale: input.rationale,
      created_by: input.created_by ?? null,
      // enabled / version / timestamps take their column defaults.
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  return row as PromptRule;
}

// Update a rule. Content changes (scope/rule/rationale) bump version; an
// enabled-only toggle does not (matches the sandbox semantics). The route
// decides which fields are present; this scopes the UPDATE to the account so a
// stale/foreign id can't be edited. Returns null when no such row for the
// account (route → 404).
export async function updatePromptRule(
  id: number,
  patch: { scope?: PromptRuleScope; rule?: string; rationale?: string; enabled?: boolean },
  accountId?: number,
): Promise<PromptRule | null> {
  const acct = accountId ?? (await getDefaultAccountId());
  const isContentChange =
    patch.scope !== undefined || patch.rule !== undefined || patch.rationale !== undefined;

  const db = getKysely();
  const row = await db
    .updateTable('prompt_rules')
    .set({
      ...(patch.scope !== undefined && { scope: patch.scope }),
      ...(patch.rule !== undefined && { rule: patch.rule }),
      ...(patch.rationale !== undefined && { rationale: patch.rationale }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      updated_at: sql<string>`NOW()`,
      // Bump version only on a content change.
      ...(isContentChange && { version: sql<number>`version + 1` }),
    })
    .where('id', '=', id)
    .where('account_id', '=', acct)
    .returning(COLUMNS)
    .executeTakeFirst();
  return (row as PromptRule | undefined) ?? null;
}

// Returns true when a row was deleted, false when the id didn't exist for the
// account (route → 404).
export async function deletePromptRule(id: number, accountId?: number): Promise<boolean> {
  const acct = accountId ?? (await getDefaultAccountId());
  const db = getKysely();
  const res = await db
    .deleteFrom('prompt_rules')
    .where('id', '=', id)
    .where('account_id', '=', acct)
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}
