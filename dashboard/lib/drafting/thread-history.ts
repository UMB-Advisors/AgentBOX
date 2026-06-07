// dashboard/lib/drafting/thread-history.ts
//
// STAQPRO-341 — walk the In-Reply-To header chain and assemble prior
// inbound + sent messages from the same thread into a context block for
// the drafting prompt.
//
// Why this over full RAG:
// - Catches ~half of "the model didn't know what we already discussed"
//   failures (per the M5 draft-quality conversation).
// - Higher signal than vector retrieval — same-thread messages are
//   guaranteed-relevant; the LLM doesn't have to figure out whether the
//   retrieved snippet actually applies.
// - Cheaper — one indexed JOIN against mailbox.inbox_messages + a UNION
//   against mailbox.sent_history. No embed, no Qdrant.
//
// Privacy gate:
// - LOCAL route — always pulls thread history.
// - CLOUD route — gated by RAG_CLOUD_ROUTE_ENABLED (same env flag as RAG
//   retrieval). Thread bodies are additional cloud-bound data; same
//   reasoning as lib/rag/retrieve.ts:retrieveForDraft.
//
// Token budget (DR-18, 4096 ctx local):
// - Cap total thread bytes at THREAD_HISTORY_CHAR_BUDGET (default 6000 chars
//   ≈ 1500 tokens — the issue specifies 1500 tokens).
// - Per-message cap at THREAD_HISTORY_PER_MSG_CHARS (default 800 chars).
// - Walk newest-to-oldest by sent_at/received_at; stop when budget runs out.
//   The newest prior messages are the highest signal for "what's the state
//   of the conversation."
//
// Pre-processing:
// - Each prior body is passed through stripQuotedAndSignature() so we don't
//   bloat the budget with nested quote-of-a-quote-of-a-quote.

import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import { stripQuotedAndSignature } from './strip-quoting';

export interface ThreadHistoryMessage {
  // Who sent it — kept as the raw RFC5322 address so the LLM can tell the
  // operator's own past replies apart from the counterparty's.
  from_addr: string;
  // Stripped body (quoting + signature removed, per-message capped).
  body_text: string;
  // Direction relative to the appliance. 'inbound' = from counterparty,
  // 'outbound' = from operator (mined from sent_history). Useful for the
  // LLM's prompt framing — let it know "this one was your past reply".
  direction: 'inbound' | 'outbound';
  // ISO-8601 timestamp. Helps the LLM ground temporal references.
  sent_at: string;
}

export interface ThreadHistoryOptions {
  // The current draft's thread_id (from mailbox.drafts.thread_id) — same as
  // Gmail's thread id, propagated through inbox_messages and sent_history.
  thread_id: string | null;
  // The current draft's message_id — the inbound being drafted FOR. Excluded
  // from history (it's already in the prompt as the inbound body).
  message_id: string | null;
  // 'local' or 'cloud' — controls the privacy gate. Cloud routes only fetch
  // history when RAG_CLOUD_ROUTE_ENABLED=1, mirroring the retrieve.ts gate.
  draft_source: 'local' | 'cloud';
}

export interface ThreadHistoryResult {
  // Newest-first list of prior messages in the thread, ready to feed into
  // assemblePrompt's `thread_context` slot. Empty array when no history
  // was found OR when gated/disabled (graceful degrade — never throws).
  messages: ReadonlyArray<ThreadHistoryMessage>;
  // Why the array is what it is. Useful for instrumentation + debugging
  // "why didn't thread history fire on this draft?" Same reason-string
  // pattern as retrieveForDraft.
  reason: 'ok' | 'no_thread_id' | 'cloud_gated' | 'no_hits' | 'disabled' | 'db_unavailable';
}

const DEFAULT_CHAR_BUDGET = 6000;
const DEFAULT_PER_MSG_CHARS = 800;

function charBudget(): number {
  const env = Number(process.env.THREAD_HISTORY_CHAR_BUDGET);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_CHAR_BUDGET;
}

function perMsgCharCap(): number {
  const env = Number(process.env.THREAD_HISTORY_PER_MSG_CHARS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_PER_MSG_CHARS;
}

function isCloudRouteEnabled(): boolean {
  return process.env.RAG_CLOUD_ROUTE_ENABLED === '1';
}

function isDisabled(): boolean {
  // Same env flag pattern as the RAG eval harness short-circuit
  // (STAQPRO-198). Operator-only — never set in production.
  return process.env.THREAD_HISTORY_DISABLED === '1';
}

interface ThreadRow {
  from_addr: string;
  body_text: string | null;
  direction: 'inbound' | 'outbound';
  sent_at: string;
}

/**
 * Fetch prior messages from the same thread, capped at a token budget,
 * pre-stripped of quote/signature noise. Newest-first ordering.
 *
 * Fail-closed semantics: any infra failure returns `{ messages: [],
 * reason: 'db_unavailable' }`. The caller (draft-prompt route) treats an
 * empty array as "no thread context to inject" — drafting proceeds.
 */
export async function getThreadHistory(opts: ThreadHistoryOptions): Promise<ThreadHistoryResult> {
  if (isDisabled()) {
    return { messages: [], reason: 'disabled' };
  }
  if (!opts.thread_id) {
    return { messages: [], reason: 'no_thread_id' };
  }
  if (opts.draft_source === 'cloud' && !isCloudRouteEnabled()) {
    return { messages: [], reason: 'cloud_gated' };
  }

  const budget = charBudget();
  const perMsg = perMsgCharCap();

  try {
    const db = getKysely();
    // UNION inbound (counterparty side) + outbound (operator's prior sends)
    // for the same thread_id. ORDER BY DESC = newest-first; LIMIT large
    // enough that the budget loop is what truncates, not SQL.
    //
    // We exclude the current draft's own inbound (`message_id`) so the
    // history block doesn't duplicate the body that's already in the
    // prompt as the inbound being drafted FOR.
    const rows = await sql<ThreadRow>`
      WITH thread_rows AS (
        SELECT
          COALESCE(im.from_addr, '') AS from_addr,
          im.body AS body_text,
          'inbound'::text AS direction,
          im.received_at::text AS sent_at,
          im.message_id
        FROM mailbox.inbox_messages im
        WHERE im.thread_id = ${opts.thread_id}
          AND (im.message_id IS NULL OR im.message_id <> COALESCE(${opts.message_id}, ''))

        UNION ALL

        SELECT
          COALESCE(sh.from_addr, '') AS from_addr,
          COALESCE(sh.draft_sent, sh.body_text) AS body_text,
          'outbound'::text AS direction,
          sh.sent_at::text AS sent_at,
          sh.message_id
        FROM mailbox.sent_history sh
        WHERE sh.thread_id = ${opts.thread_id}
      )
      SELECT from_addr, body_text, direction, sent_at
      FROM thread_rows
      WHERE body_text IS NOT NULL
        AND LENGTH(TRIM(body_text)) > 0
      ORDER BY sent_at DESC
      LIMIT 50
    `.execute(db);

    if (rows.rows.length === 0) {
      return { messages: [], reason: 'no_hits' };
    }

    const out: ThreadHistoryMessage[] = [];
    let used = 0;
    for (const r of rows.rows) {
      const stripped = stripQuotedAndSignature(r.body_text ?? '', { maxChars: perMsg });
      if (stripped.body.length === 0) continue;
      // Reserve ~32 chars per message for the "From: ..." header + separators
      // we render in prompt.ts:threadBlock. Slight over-estimate is fine.
      const cost = stripped.body.length + 32;
      if (used + cost > budget) break;
      used += cost;
      out.push({
        from_addr: r.from_addr,
        body_text: stripped.body,
        direction: r.direction,
        sent_at: r.sent_at,
      });
    }

    if (out.length === 0) {
      return { messages: [], reason: 'no_hits' };
    }
    return { messages: out, reason: 'ok' };
  } catch (error) {
    console.error('getThreadHistory failed:', error);
    return { messages: [], reason: 'db_unavailable' };
  }
}
