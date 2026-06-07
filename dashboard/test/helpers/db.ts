import { Pool } from 'pg';
import type { Category } from '@/lib/classification/prompt';
import type { DraftStatus } from '@/lib/types';

// Test helpers for route tests that need a real Postgres. The route handlers
// call `getPool()` from `lib/db.ts`, which reads `POSTGRES_URL`. To make sure
// the route + the seeding helpers see the same DB, mirror TEST_POSTGRES_URL
// onto POSTGRES_URL early — before any module that captures pool state.
if (process.env.TEST_POSTGRES_URL && !process.env.POSTGRES_URL) {
  process.env.POSTGRES_URL = process.env.TEST_POSTGRES_URL;
}

const DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;
export const HAS_DB = Boolean(DB_URL);

let pool: Pool | undefined;
export function getTestPool(): Pool {
  if (!HAS_DB) throw new Error('TEST_POSTGRES_URL/POSTGRES_URL not set');
  if (!pool) pool = new Pool({ connectionString: DB_URL, max: 2 });
  return pool;
}

export async function closeTestPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export interface SeededDraft {
  draftId: number;
  inboxMessageId: number;
}

let seedCounter = 0;

export interface SeedOpts {
  status?: DraftStatus;
  classification?: Category;
  draftBody?: string;
  draftSubject?: string;
  withClassification?: boolean;
  // STAQPRO-331 #2 — seed RAG context for rag-refs route tests.
  // ragContextRefs: array of Qdrant point UUIDs (stored as jsonb). Default [].
  // ragRetrievalReason: TEXT default 'none' on the column; pass 'ok' | 'no_hits' | etc to exercise empty-refs branches.
  ragContextRefs?: readonly string[];
  ragRetrievalReason?: string;
  // STAQPRO-333 — seed KB refs alongside email refs so rag-refs route tests
  // can exercise the kb-context-refs resolution path. Same jsonb shape as
  // rag_context_refs; default [].
  kbContextRefs?: readonly string[];
  // MBOX-360 (MBOX-162 V3) — owning account for the seeded draft + its inbox
  // row. Omitted → the column DEFAULT (the seeded default account). Set to a
  // 2nd account id to exercise the account filter.
  accountId?: number;
}

export async function seedDraft(opts: SeedOpts = {}): Promise<SeededDraft> {
  const status = opts.status ?? 'pending';
  const classification = opts.classification ?? 'reorder';
  const draftBody = opts.draftBody ?? 'Hi! Thanks for the order — confirming details.';
  const draftSubject = opts.draftSubject ?? 'Re: order confirmation';
  const withClassification = opts.withClassification !== false;
  const ragContextRefs = opts.ragContextRefs ?? [];
  const ragRetrievalReason = opts.ragRetrievalReason ?? 'none';
  const kbContextRefs = opts.kbContextRefs ?? [];
  const tag = `test-${Date.now()}-${++seedCounter}-${Math.random().toString(36).slice(2, 8)}`;

  const pool = getTestPool();

  const inbox = await pool.query<{ id: number }>(
    `INSERT INTO mailbox.inbox_messages
       (message_id, from_addr, to_addr, subject, body, received_at)
     VALUES ($1, 'sender@example.com', 'op@example.com', $2, 'inbound test body', NOW())
     RETURNING id`,
    [tag, `test inbound ${tag}`],
  );
  const inboxMessageId = inbox.rows[0].id;

  const draft = await pool.query<{ id: number }>(
    `INSERT INTO mailbox.drafts
       (inbox_message_id, draft_body, draft_subject, model, status,
        classification_category, classification_confidence,
        from_addr, to_addr, subject, body_text,
        rag_context_refs, rag_retrieval_reason, kb_context_refs)
     VALUES ($1, $2, $3, 'qwen3:4b-ctx4k', $4, $5, $6,
             'sender@example.com', 'op@example.com',
             $7, 'inbound test body',
             $8::jsonb, $9, $10::jsonb)
     RETURNING id`,
    [
      inboxMessageId,
      draftBody,
      draftSubject,
      status,
      withClassification ? classification : null,
      withClassification ? 0.92 : null,
      `test inbound ${tag}`,
      JSON.stringify([...ragContextRefs]),
      ragRetrievalReason,
      JSON.stringify([...kbContextRefs]),
    ],
  );
  const draftId = draft.rows[0].id;

  // MBOX-360 — re-home both rows onto a specific account when requested (the
  // INSERTs above use the account_id column DEFAULT = the default account).
  if (opts.accountId !== undefined) {
    await pool.query('UPDATE mailbox.inbox_messages SET account_id = $1 WHERE id = $2', [
      opts.accountId,
      inboxMessageId,
    ]);
    await pool.query('UPDATE mailbox.drafts SET account_id = $1 WHERE id = $2', [
      opts.accountId,
      draftId,
    ]);
  }
  return { draftId, inboxMessageId };
}

export async function deleteSeededDraft(s: SeededDraft): Promise<void> {
  const pool = getTestPool();
  await pool.query('DELETE FROM mailbox.drafts WHERE id = $1', [s.draftId]);
  await pool.query('DELETE FROM mailbox.inbox_messages WHERE id = $1', [s.inboxMessageId]);
}

export async function getDraftStatus(id: number): Promise<DraftStatus | null> {
  const pool = getTestPool();
  const r = await pool.query<{ status: DraftStatus }>(
    'SELECT status FROM mailbox.drafts WHERE id = $1',
    [id],
  );
  return r.rows[0]?.status ?? null;
}

export async function getDraftRow(id: number): Promise<{
  status: DraftStatus;
  draft_body: string;
  draft_subject: string | null;
  error_message: string | null;
} | null> {
  const pool = getTestPool();
  const r = await pool.query(
    'SELECT status, draft_body, draft_subject, error_message FROM mailbox.drafts WHERE id = $1',
    [id],
  );
  return r.rows[0] ?? null;
}

// STAQPRO-331 #9 — read the latest mailbox.state_transitions row for a draft.
// Column names per migration 009: from_status, to_status, actor, reason,
// transitioned_at.
export async function getLatestTransition(draftId: number): Promise<{
  from_status: string;
  to_status: string;
  actor: string;
  reason: string | null;
} | null> {
  const pool = getTestPool();
  const r = await pool.query<{
    from_status: string;
    to_status: string;
    actor: string;
    reason: string | null;
  }>(
    `SELECT from_status, to_status, actor, reason
       FROM mailbox.state_transitions
      WHERE draft_id = $1
      ORDER BY transitioned_at DESC
      LIMIT 1`,
    [draftId],
  );
  return r.rows[0] ?? null;
}

// Build a minimal NextRequest stand-in that satisfies the call sites in our
// route handlers (they only touch .url and .json()).
export function fakeRequest(
  opts: { url?: string; body?: unknown } = {},
): import('next/server').NextRequest {
  const url = opts.url ?? 'http://test.local/api';
  return {
    url,
    json: async () => {
      if (opts.body === undefined) throw new Error('no body');
      return opts.body;
    },
  } as unknown as import('next/server').NextRequest;
}
