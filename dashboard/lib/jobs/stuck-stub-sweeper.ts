// dashboard/lib/jobs/stuck-stub-sweeper.ts
//
// STAQPRO-287 — auto-recover drafts stuck in stub state.
//
// Failure mode: when MailBOX-Draft errors (e.g. /api/internal/draft-finalize
// 400 because Qwen3 returned empty body, or transient Ollama 5xx), the
// initial draft stub created by MailBOX-Classify's `Insert Draft Stub`
// node is left in place forever:
//   status='pending'  AND  model='pending'  AND  draft_body=''  (or stub)
// n8n nodes have 0 retries by default (per the n8n boundary contract) and
// no operator workflow surfaces these — they just accumulate as ghost
// drafts in the queue.
//
// Tick (every 5 min via instrumentation.ts):
//   1. Acquire single-process advisory lock (overlapping ticks would
//      double-fire the LLM and double-finalize).
//   2. Find pending+stub drafts created at least 5 min ago. Hard-fail
//      drafts older than HARD_FAIL_AGE_MIN by marking them rejected
//      with reason='stuck_stub_unrecoverable'.
//   3. For each remaining: re-drive the draft pipeline by calling the
//      existing /api/internal/draft-prompt + /api/internal/draft-finalize
//      routes via in-process HTTP. Same code path n8n would run; the
//      sweeper just substitutes for the n8n executeWorkflow trigger.
//   4. Per-row try/catch — one bad row doesn't poison the tick.
//
// Why HTTP self-calls instead of importing the route handlers? Two
// reasons: (a) the route handlers do zod validation + cost computation
// + writeback that we'd have to replicate inline; (b) the cost is ~5ms
// over the docker bridge — irrelevant compared to the multi-second LLM
// call. The classify-sweeper bypasses HTTP because its rows are 50/tick;
// this sweeper's row count is small and the LLM dominates latency.
//
// Hard-fail age (HARD_FAIL_AGE_MIN, default 30 min) caps the auto-retry
// loop — equivalent to "give up after ~5 ticks." When an inbound email
// has structurally-empty content (Google Calendar invites, etc.) Qwen3
// will keep returning empty, and we shouldn't churn the queue forever.

import { sql } from 'kysely';
import { getKysely, getPool } from '@/lib/db';
import { withJobRun } from '@/lib/jobs/job-runs';

// Advisory lock keys are global across the database — each sweeper owns its
// own integer. Map (audit 2026-05-15):
//   classify-sweeper       = 7234567
//   gmail-ratelimit-sweeper = 7234568
//   stuck-stub-sweeper      = 7234569  (was 7234568 — collided with gmail-ratelimit)
const LOCK_KEY = 7234569;
const STUCK_AGE_MIN = 5;
const HARD_FAIL_AGE_MIN = 30;
const ROW_LIMIT = 10;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

// Per-call HTTP timeouts. Without these, a hung dashboard or LLM holds the
// per-row promise indefinitely; the outer advisory-lock unlock waits on the
// for-loop, so every subsequent tick is a silent no-op.
const DASHBOARD_HTTP_TIMEOUT_MS = Number(process.env.STUCK_STUB_DASHBOARD_TIMEOUT_MS ?? 30_000);
const LLM_TIMEOUT_MS = Number(process.env.STUCK_STUB_LLM_TIMEOUT_MS ?? 180_000);

const DASHBOARD_URL = process.env.STUCK_STUB_DASHBOARD_URL ?? 'http://localhost:3001';

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const ctrl = new AbortController();
  const handle = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`${label} -> timeout after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(handle);
  }
}

interface SweeperResult {
  checked: number;
  recovered: number;
  hard_failed: number;
  retry_failed: number;
}

interface StuckRow {
  id: number;
  age_minutes: number;
}

interface DraftPromptResponse {
  draft_id: number;
  baseUrl: string;
  apiKey: string;
  model: string;
  source: 'local' | 'cloud';
  display_label?: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
}

interface OllamaChatResponse {
  message?: { role: string; content: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

async function fetchPromptPayload(draftId: number): Promise<DraftPromptResponse> {
  const res = await fetchWithTimeout(
    `${DASHBOARD_URL}/api/internal/draft-prompt`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft_id: draftId }),
    },
    DASHBOARD_HTTP_TIMEOUT_MS,
    'draft-prompt',
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`draft-prompt -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as DraftPromptResponse;
}

async function callLlm(
  payload: DraftPromptResponse,
): Promise<{ body: string; input_tokens?: number; output_tokens?: number }> {
  // Ollama-shape /api/chat for both local Qwen3 and Ollama Cloud (gpt-oss:120b).
  // Anthropic alt-cloud route would need a different request shape — this
  // sweeper is scoped to the live default. If that flips, extend here.
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (payload.apiKey) headers.authorization = `Bearer ${payload.apiKey}`;

  const res = await fetchWithTimeout(
    `${payload.baseUrl}/api/chat`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: payload.model,
        messages: payload.messages,
        stream: false,
        options: {
          temperature: payload.temperature ?? 0.3,
          num_predict: payload.max_tokens ?? 600,
        },
      }),
    },
    LLM_TIMEOUT_MS,
    `llm ${payload.model}`,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`llm ${payload.model} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as OllamaChatResponse;
  const body = (json.message?.content ?? '').trim();
  return {
    body,
    input_tokens: json.prompt_eval_count,
    output_tokens: json.eval_count,
  };
}

async function postFinalize(
  draftId: number,
  body: string,
  source: 'local' | 'cloud',
  model: string,
  input_tokens?: number,
  output_tokens?: number,
): Promise<void> {
  const res = await fetchWithTimeout(
    `${DASHBOARD_URL}/api/internal/draft-finalize`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draft_id: draftId,
        body,
        source,
        model,
        input_tokens,
        output_tokens,
      }),
    },
    DASHBOARD_HTTP_TIMEOUT_MS,
    'draft-finalize',
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`draft-finalize -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function rejectAsUnrecoverable(draftId: number): Promise<void> {
  // Use raw pg client so we can set the session-local GUCs that the
  // state_transitions trigger reads (actor='system', reason='...').
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('mailbox.actor', 'system', true)");
    await client.query(
      "SELECT set_config('mailbox.transition_reason', 'stuck_stub_unrecoverable', true)",
    );
    await client.query(
      "UPDATE mailbox.drafts SET status = 'rejected' WHERE id = $1 AND status = 'pending' AND model = 'pending'",
      [draftId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function recoverDraft(draftId: number): Promise<void> {
  const payload = await fetchPromptPayload(draftId);
  const llm = await callLlm(payload);
  if (!llm.body) {
    throw new Error(`empty body from ${payload.model}`);
  }
  await postFinalize(
    draftId,
    llm.body,
    payload.source,
    payload.model,
    llm.input_tokens,
    llm.output_tokens,
  );
}

export async function runStuckStubSweeperTick(): Promise<SweeperResult> {
  const db = getKysely();
  const result: SweeperResult = { checked: 0, recovered: 0, hard_failed: 0, retry_failed: 0 };

  const lock = await sql<{ acquired: boolean }>`
    SELECT pg_try_advisory_lock(${LOCK_KEY}) AS acquired
  `.execute(db);
  if (!lock.rows[0]?.acquired) return result;

  try {
    // Cast EXTRACT/60 to int4 — Postgres `numeric` types come back as JS
    // strings via the dashboard's pg type-parser convention (preserved by
    // setTypeParser overrides in lib/db.ts). int4 round-trips as a real
    // number which we need for .toFixed() in the log lines below.
    const queryResult = await sql<StuckRow>`
      SELECT id,
             (EXTRACT(EPOCH FROM (NOW() - created_at)) / 60)::int AS age_minutes
        FROM mailbox.drafts
       WHERE status = 'pending'
         AND model = 'pending'
         AND created_at < NOW() - make_interval(mins => ${STUCK_AGE_MIN})
    ORDER BY created_at ASC
       LIMIT ${ROW_LIMIT}
    `.execute(db);

    result.checked = queryResult.rows.length;
    for (const row of queryResult.rows) {
      const age = Number(row.age_minutes); // defense in depth — coerce even if pg parser changes
      if (age >= HARD_FAIL_AGE_MIN) {
        try {
          await rejectAsUnrecoverable(row.id);
        } catch (e) {
          result.retry_failed += 1;
          console.error(
            `[stuck-stub-sweeper] id=${row.id} hard-fail update failed:`,
            e instanceof Error ? e.message : String(e),
          );
          continue;
        }
        result.hard_failed += 1;
        console.log(`[stuck-stub-sweeper] id=${row.id} hard-failed (age=${age.toFixed(1)}m)`);
        continue;
      }

      try {
        await recoverDraft(row.id);
      } catch (e) {
        result.retry_failed += 1;
        console.error(
          `[stuck-stub-sweeper] id=${row.id} recovery failed (age=${age.toFixed(1)}m):`,
          e instanceof Error ? e.message : String(e),
        );
        continue;
      }
      result.recovered += 1;
      console.log(`[stuck-stub-sweeper] id=${row.id} recovered (age=${age.toFixed(1)}m)`);
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`.execute(db);
  }

  if (result.checked > 0) {
    console.log(`[stuck-stub-sweeper] tick: ${JSON.stringify(result)}`);
  }
  return result;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startStuckStubSweeper(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (intervalHandle) return;
  console.log(`[stuck-stub-sweeper] starting (interval=${intervalMs}ms)`);
  intervalHandle = setInterval(() => {
    withJobRun('stuck-stub-sweeper', runStuckStubSweeperTick).catch((e: unknown) => {
      console.error('[stuck-stub-sweeper] tick error:', e instanceof Error ? e.message : String(e));
    });
  }, intervalMs);
}
