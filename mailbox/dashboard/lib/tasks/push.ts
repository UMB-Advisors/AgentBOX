// dashboard/lib/tasks/push.ts
//
// MBOX-129 — push orchestration for the action-item → task handoff.
//
// Reads a draft's action_items (positional jsonb array on mailbox.drafts),
// pushes the targeted item(s) to the configured provider, and writes the
// resulting task_external_id / task_external_url / task_pushed_at back onto the
// SAME array element. Idempotent: re-pushing an item that already has a
// task_external_id UPDATEs the existing task (no duplicate).
//
// Audit (STAQPRO-185): each push sets the mailbox.actor + mailbox.transition_
// reason GUCs ('push_task' on success, 'push_task_failure' on failure) inside
// the writeback transaction so the state_transitions trigger attributes
// correctly IF a status-touching write ever joins this transaction. Per CLAUDE
// .md, a task-push failure does NOT flip draft status — it leaves the draft at
// approved/sent (same as the Gmail send_failure pattern); the failure is logged
// + surfaced in the response, and a state_transitions row is written by an
// explicit append (see recordPushAudit) so the audit log surfaces it even
// though no status changed.

import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import { type ActionItem, DEFAULT_TASK_PROVIDER, type TaskProvider } from '@/lib/types';
import { pushToGoogleTasks, TaskPushError } from './google-tasks';

export interface PushOutcome {
  // The full, updated action_items array (with task fields populated on pushed
  // items) so the caller can return it to the client for an optimistic update.
  action_items: ActionItem[];
  // Per-item push results keyed by array index.
  results: Array<{
    index: number;
    ok: boolean;
    task_external_id?: string;
    task_external_url?: string;
    error?: string;
    error_kind?: string;
  }>;
}

export class PushNotFoundError extends Error {}
export class PushIndexError extends Error {}

function resolveProvider(provider?: TaskProvider): TaskProvider {
  const fromEnv = process.env.TASK_PROVIDER?.trim() as TaskProvider | undefined;
  return provider ?? fromEnv ?? DEFAULT_TASK_PROVIDER;
}

async function pushOne(
  item: ActionItem,
  draftId: number,
  provider: TaskProvider,
): Promise<{ task_external_id: string; task_external_url: string }> {
  if (provider === 'google_tasks') {
    return pushToGoogleTasks(item, draftId, item.task_external_id ?? null);
  }
  // 'linear' is reserved for the v2 toggle (MBOX-129 out-of-scope). Fail
  // explicitly rather than silently no-op.
  throw new TaskPushError(`provider '${provider}' not wired in v1`, 'client_error');
}

// Write an append-only audit row to mailbox.state_transitions for a push.
// drafts.status is NOT changed (per the Gmail send_failure convention), so the
// AFTER UPDATE OF status trigger would not fire — we insert directly here with
// the same actor/reason vocabulary the trigger uses. from_status == to_status
// (the draft's current status) because a push doesn't transition the draft.
async function recordPushAudit(
  draftId: number,
  reason: 'push_task' | 'push_task_failure',
  detail: string,
): Promise<void> {
  const db = getKysely();
  try {
    await sql`
      INSERT INTO mailbox.state_transitions (draft_id, from_status, to_status, actor, reason)
      SELECT id, status, status, 'operator', ${`${reason}: ${detail}`.slice(0, 500)}
        FROM mailbox.drafts WHERE id = ${draftId}
    `.execute(db);
  } catch (err) {
    // Audit is best-effort — never fail the push because the audit insert
    // failed (e.g. a schema variation on a not-yet-migrated box).
    console.warn(`recordPushAudit draft=${draftId} reason=${reason} failed:`, err);
  }
}

// Push a single item (by index) or all unpushed items (bulk) on a draft.
//
// CONCURRENCY CAVEAT (MBOX-129): the read-then-write below is NOT serialized
// against concurrent requests. The action_items snapshot is read outside the
// writeback transaction, so two concurrent `{ all: true }` pushes for the same
// draft can both observe the same un-pushed items and double-create tasks in
// Google (the UI `pushBusy` guard is client-side only and does not protect
// against multi-tab / multi-operator races). A `SELECT … FOR UPDATE` on the
// draft row would close this, but it would have to wrap the per-item Google
// API calls (8s timeout each) to cover the create, holding a Postgres row lock
// across external network I/O for the whole bulk loop — a worse failure mode
// (lock contention / pool starvation). The per-item PATCH idempotency only
// kicks in AFTER task_external_id is persisted, so it does not cover the
// concurrent first-push window. Revisit with an advisory lock keyed on draft_id
// if concurrent bulk pushes become a real operator path.
export async function pushActionItems(input: {
  draftId: number;
  index?: number;
  all?: boolean;
  provider?: TaskProvider;
}): Promise<PushOutcome> {
  const provider = resolveProvider(input.provider);
  const db = getKysely();

  // Read the current array.
  const row = await db
    .selectFrom('drafts')
    .select(['id', 'action_items'])
    .where('id', '=', input.draftId)
    .limit(1)
    .executeTakeFirst();
  if (!row) throw new PushNotFoundError('draft_not_found');

  const items = (row.action_items as ActionItem[] | null) ?? [];

  // Which indices to push.
  let targets: number[];
  if (input.all) {
    // Bulk: every item not already pushed (no task_external_id yet).
    targets = items.map((_, i) => i).filter((i) => !items[i].task_external_id);
  } else {
    if (typeof input.index !== 'number' || input.index < 0 || input.index >= items.length) {
      throw new PushIndexError('index_out_of_range');
    }
    targets = [input.index];
  }

  const results: PushOutcome['results'] = [];
  const next = items.map((it) => ({ ...it }));

  for (const i of targets) {
    try {
      const pushed = await pushOne(next[i], input.draftId, provider);
      next[i].task_external_id = pushed.task_external_id;
      next[i].task_external_url = pushed.task_external_url;
      next[i].task_pushed_at = new Date().toISOString();
      results.push({
        index: i,
        ok: true,
        task_external_id: pushed.task_external_id,
        task_external_url: pushed.task_external_url,
      });
      await recordPushAudit(input.draftId, 'push_task', `idx=${i} id=${pushed.task_external_id}`);
    } catch (err) {
      const kind = err instanceof TaskPushError ? err.kind : 'transient';
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ index: i, ok: false, error: msg, error_kind: kind });
      await recordPushAudit(input.draftId, 'push_task_failure', `idx=${i} kind=${kind} ${msg}`);
      // Don't abort the bulk loop on one failure — push what we can; the
      // operator retries the failures individually.
    }
  }

  // Persist the array only if at least one push succeeded (so a pure-failure
  // run doesn't rewrite the row needlessly). Set the actor/reason GUCs in the
  // same transaction per the attribution convention.
  const anySuccess = results.some((r) => r.ok);
  if (anySuccess) {
    await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('mailbox.actor', 'operator', true)`.execute(trx);
      await sql`SELECT set_config('mailbox.transition_reason', 'push_task', true)`.execute(trx);
      await trx
        .updateTable('drafts')
        .set({
          action_items: sql`${JSON.stringify(next)}::jsonb`,
          updated_at: sql<string>`NOW()`,
        })
        .where('id', '=', input.draftId)
        .execute();
    });
  }

  return { action_items: next, results };
}
