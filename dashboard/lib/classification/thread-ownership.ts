// UMB-154 — operator-owns-thread guard.
//
// Determines whether an operator-domain address has recently sent a message
// in the given thread. If so, the operator is actively "owning" this
// conversation and no draft is needed — generating one would produce a
// duplicative or contradictory reply (live draft-158 case: jt@ replied, then
// shabegsh@ sent "Got it - thanks!" and a second draft was queued).
//
// "Owned" = any operator-domain address sent a message in this thread within
// the active window (default 24h). Source: union of:
//   (a) mailbox.sent_history rows (from_addr operator-side, thread_id match)
//   (b) mailbox.inbox_messages rows (from_addr operator-side, thread_id match)
//       — covers operator messages that arrived back as inbound (self-loops).
//
// Fail-open on every uncertain branch: null thread_id, DB error, kill switch
// → owned:false, so we never suppress a legitimate customer draft on infra
// failure or incomplete data.
//
// Configuration:
//   OPERATOR_THREAD_WINDOW_HOURS    = active window in hours (default 24)
//   OPERATOR_THREAD_GUARD_DISABLE   = '1' to short-circuit (mirrors other guards)

import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import { extractAddress, isOperatorAddress, OPERATOR_INBOX_EXCEPTIONS } from './preclass';

export interface OwnershipOpts {
  thread_id: string | null | undefined;
  // Injectable clock so tests can pin the window deterministically.
  now?: Date;
}

export interface OwnershipResult {
  owned: boolean;
  reason:
    | 'operator_owns_thread'
    | 'lapsed'
    | 'no_operator_msg'
    | 'no_thread_id'
    | 'db_unavailable'
    | 'disabled';
  // ISO-8601 string of the most recent operator-domain message in this thread.
  // Present only when owned:true or lapsed.
  last_operator_reply_at?: string;
}

function windowHours(): number {
  const env = Number(process.env.OPERATOR_THREAD_WINDOW_HOURS);
  return Number.isFinite(env) && env > 0 ? env : 24;
}

function isDisabled(): boolean {
  return process.env.OPERATOR_THREAD_GUARD_DISABLE === '1';
}

interface ThreadRow {
  from_addr: string;
  sent_at: string;
}

/**
 * Returns whether an operator-domain address owns this thread (replied within
 * the active window). Fail-open: never suppresses on infra failure.
 */
export async function operatorOwnsThread(opts: OwnershipOpts): Promise<OwnershipResult> {
  if (isDisabled()) {
    return { owned: false, reason: 'disabled' };
  }

  if (!opts.thread_id) {
    return { owned: false, reason: 'no_thread_id' };
  }

  const threadId = opts.thread_id;

  try {
    const db = getKysely();

    // Fetch candidate rows from both sent_history and inbox_messages for
    // this thread — small LIMIT, filter operator-side in TS so the
    // operator-domain definition stays single-sourced in preclass.ts.
    const rows = await sql<ThreadRow>`
      SELECT from_addr, sent_at::text AS sent_at
      FROM mailbox.sent_history
      WHERE thread_id = ${threadId}

      UNION ALL

      SELECT from_addr, received_at::text AS sent_at
      FROM mailbox.inbox_messages
      WHERE thread_id = ${threadId}
        AND received_at IS NOT NULL

      ORDER BY sent_at DESC
      LIMIT 100
    `.execute(db);

    // Filter to operator-side rows only. Role-inbox exceptions (sales@, etc.)
    // are addresses the appliance drafts FOR, not personal operators — a reply
    // from them does NOT mean a human owns the thread, so exclude them here
    // (mirrors precheckSelfLoop's OPERATOR_INBOX_EXCEPTIONS guard).
    const operatorRows = rows.rows.filter((r) => {
      const addr = extractAddress(r.from_addr);
      if (!addr) return false;
      if (OPERATOR_INBOX_EXCEPTIONS.includes(addr)) return false;
      return isOperatorAddress(addr);
    });

    if (operatorRows.length === 0) {
      return { owned: false, reason: 'no_operator_msg' };
    }

    // Most-recent operator message (rows are already ordered DESC by sent_at).
    const latestRow = operatorRows[0];
    const lastAt = new Date(latestRow.sent_at);
    const now = opts.now ?? new Date();
    const windowMs = windowHours() * 60 * 60 * 1000;

    if (now.getTime() - lastAt.getTime() <= windowMs) {
      return {
        owned: true,
        reason: 'operator_owns_thread',
        last_operator_reply_at: latestRow.sent_at,
      };
    }

    return {
      owned: false,
      reason: 'lapsed',
      last_operator_reply_at: latestRow.sent_at,
    };
  } catch (error) {
    console.error('[classify] operatorOwnsThread db error:', error);
    return { owned: false, reason: 'db_unavailable' };
  }
}
