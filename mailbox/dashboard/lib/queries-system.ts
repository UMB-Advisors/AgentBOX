import { statfs } from 'node:fs/promises';
import { sql } from 'kysely';
import { getKysely } from '@/lib/db';

// Per-field helpers for /api/system/status (STAQPRO-146 / FR-29). Each helper
// fails closed: on error, returns null rather than throwing — the status
// endpoint should always return 200 with a partial payload, never 500.

export async function getQueueDepth(): Promise<number> {
  const db = getKysely();
  const r = await db
    .selectFrom('drafts')
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .where('status', 'in', ['pending', 'awaiting_cloud'])
    .executeTakeFirstOrThrow();
  return Number(r.c);
}

export async function getLastError(): Promise<{
  message: string | null;
  at: string | null;
}> {
  const db = getKysely();
  const r = await db
    .selectFrom('drafts')
    .select(['error_message', 'updated_at'])
    .where('error_message', 'is not', null)
    .orderBy('updated_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return {
    message: r?.error_message ?? null,
    at: (r?.updated_at as string | undefined) ?? null,
  };
}

export async function getLastInferenceLatency(): Promise<{
  latency_ms: number | null;
  at: string | null;
}> {
  const db = getKysely();
  const r = await db
    .selectFrom('classification_log')
    .select(['latency_ms', 'created_at'])
    .where('latency_ms', 'is not', null)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return {
    latency_ms: r?.latency_ms ?? null,
    at: (r?.created_at as string | undefined) ?? null,
  };
}

export async function getLastEmailReceivedAt(): Promise<string | null> {
  const db = getKysely();
  const r = await db
    .selectFrom('inbox_messages')
    .select((eb) => eb.fn.max('received_at').as('m'))
    .executeTakeFirstOrThrow();
  return (r.m as string | null) ?? null;
}

// Catches the failure mode where ingestion writes to inbox_messages but the
// downstream MailBOX-Classify sub-workflow stops firing (e.g., the 2026-05-01
// n8n upgrade left it active=false; STAQPRO-135 hit the same gotcha). The
// "Last classified" Stat alone can look fresh during a quiet inbox; pair it
// with `unclassifiedCount24h > 0` + `unclassifiedSince` to detect a stall.
export interface ClassificationHealth {
  lastClassifiedAt: string | null;
  unclassifiedSince: string | null;
  unclassifiedCount24h: number;
}

export async function getClassificationHealth(): Promise<ClassificationHealth> {
  const db = getKysely();
  const latest = await db
    .selectFrom('classification_log')
    .select((eb) => eb.fn.max('created_at').as('m'))
    .executeTakeFirstOrThrow();

  const backlog = await sql<{ count: string; oldest: string | null }>`
    SELECT
      COUNT(*)::text AS count,
      MIN(m.received_at)::text AS oldest
    FROM mailbox.inbox_messages m
    LEFT JOIN mailbox.classification_log c ON c.inbox_message_id = m.id
    WHERE c.id IS NULL
      AND m.received_at > NOW() - INTERVAL '24 hours'
  `.execute(db);

  const row = backlog.rows[0];
  return {
    lastClassifiedAt: (latest.m as string | null) ?? null,
    unclassifiedSince: row?.oldest ?? null,
    unclassifiedCount24h: row ? Number(row.count) : 0,
  };
}

// n8n's workflow_entity lives in the `public` schema, outside the kysely-codegen
// scope. Use sql template + raw query rather than expanding the codegen include
// pattern — n8n's schema is upstream-managed and shouldn't be a source of
// kysely types.
export async function getActiveWorkflowCount(): Promise<number | null> {
  const db = getKysely();
  try {
    const r = await sql<{ count: string }>`
      SELECT COUNT(*)::text AS count
      FROM public.workflow_entity
      WHERE active = true
    `.execute(db);
    const row = r.rows[0];
    return row ? Number(row.count) : 0;
  } catch (error) {
    console.error('getActiveWorkflowCount failed:', error);
    return null;
  }
}

export async function getDiskFree(
  path = '/',
): Promise<{ free_bytes: number; total_bytes: number } | null> {
  try {
    const s = await statfs(path);
    return {
      free_bytes: s.bavail * s.bsize,
      total_bytes: s.blocks * s.bsize,
    };
  } catch (error) {
    console.error('getDiskFree failed:', error);
    return null;
  }
}

interface OllamaModel {
  name: string;
  size_vram?: number;
}

export async function getOllamaLoadedModels(): Promise<OllamaModel[] | null> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434';
  try {
    const res = await fetch(`${baseUrl}/api/ps`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: OllamaModel[] };
    return data.models ?? [];
  } catch {
    return null;
  }
}

// STAQPRO-188 — Qdrant collection health for the status page. The
// `email_messages` collection is the RAG corpus surface (M3.5). Points-count
// surfaces "is the corpus populated yet" without operators having to open the
// Qdrant dashboard.
//
// Returns null when Qdrant is unreachable; returns `{ exists: false }` when
// reachable but the collection is missing (bootstrap hasn't run, or ran and
// failed). Status page should treat null as red and exists:false as orange.
export interface QdrantCollectionHealth {
  exists: boolean;
  points_count: number | null;
  vectors_count: number | null;
}

interface QdrantCollectionInfo {
  result?: {
    points_count?: number;
    vectors_count?: number;
  };
}

export async function getQdrantCollectionHealth(
  collection = 'email_messages',
): Promise<QdrantCollectionHealth | null> {
  const baseUrl = process.env.QDRANT_URL ?? 'http://qdrant:6333';
  try {
    const res = await fetch(`${baseUrl}/collections/${collection}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.status === 404) {
      return { exists: false, points_count: null, vectors_count: null };
    }
    if (!res.ok) return null;
    const data = (await res.json()) as QdrantCollectionInfo;
    return {
      exists: true,
      points_count: data.result?.points_count ?? null,
      vectors_count: data.result?.vectors_count ?? null,
    };
  } catch {
    return null;
  }
}

export interface CloudSpend24h {
  total_usd: number;
  call_count: number;
  by_source: Record<string, { total_usd: number; call_count: number }>;
}

// Cost meter aggregation. Per-call cost is already persisted to
// mailbox.drafts.cost_usd via computeCost() in draft-finalize. No separate
// cloud_calls log table needed — drafts IS the per-call log given each draft
// finalize call is one cloud LLM call. Updated for DR-23 supersession: cloud
// spend covers Ollama Cloud (gpt-oss:120b primary) AND Anthropic (alt-cloud
// when ANTHROPIC_API_KEY is set), grouped by drafts.draft_source.
export async function getCloudSpend24h(): Promise<CloudSpend24h> {
  const db = getKysely();
  const rows = await db
    .selectFrom('drafts')
    .select((eb) => [
      eb.ref('draft_source').as('source'),
      eb.fn.sum<string>('cost_usd').as('total'),
      eb.fn.countAll<string>().as('count'),
    ])
    .where(sql<boolean>`created_at > now() - interval '24 hours'`)
    .where('draft_source', 'is not', null)
    .where('cost_usd', 'is not', null)
    .groupBy('draft_source')
    .execute();

  const result: CloudSpend24h = { total_usd: 0, call_count: 0, by_source: {} };
  for (const row of rows) {
    if (!row.source) continue;
    const usd = Number(row.total ?? 0);
    const count = Number(row.count ?? 0);
    result.by_source[row.source] = { total_usd: usd, call_count: count };
    // Only count rows where the route went CLOUD (not local) toward the
    // cloud-spend meter. Local Qwen3 calls cost $0 (run on-device) and
    // shouldn't show up in the spend meter even if cost_usd was populated.
    if (row.source === 'cloud' || row.source === 'cloud_haiku') {
      result.total_usd += usd;
      result.call_count += count;
    }
  }
  return result;
}

export interface DraftCounts24h {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  rejected: number;
}

// STAQPRO-128 — operator-facing alert inputs.
//
// Each helper fails closed (returns null on error) so the alert evaluator
// simply skips that input rather than failing the whole status response.

export interface DraftBacklogAged {
  aged_count: number;
  threshold_hours: number;
}

export async function getDraftBacklogAged(thresholdHours: number): Promise<DraftBacklogAged> {
  const db = getKysely();
  const r = await db
    .selectFrom('drafts')
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .where('status', 'in', ['pending', 'awaiting_cloud'])
    .where(sql<boolean>`created_at < now() - make_interval(hours => ${thresholdHours})`)
    .executeTakeFirstOrThrow();
  return { aged_count: Number(r.c), threshold_hours: thresholdHours };
}

export interface N8nFailures24h {
  failed_count: number;
  total_count: number;
}

// n8n's execution_entity lives in the public schema (outside kysely-codegen
// scope). Use a raw template query — same pattern as getActiveWorkflowCount.
//
// Failure detection: `finished = false AND "stoppedAt" IS NOT NULL` matches
// errored or canceled runs in both n8n 1.x and 2.x without depending on the
// 2.x-only `status` enum column.
export async function getN8nFailures24h(): Promise<N8nFailures24h | null> {
  const db = getKysely();
  try {
    const r = await sql<{ failed: string; total: string }>`
      SELECT
        COUNT(*) FILTER (WHERE finished = false AND "stoppedAt" IS NOT NULL)::text AS failed,
        COUNT(*)::text AS total
      FROM public.execution_entity
      WHERE "startedAt" > NOW() - INTERVAL '24 hours'
    `.execute(db);
    const row = r.rows[0];
    if (!row) return { failed_count: 0, total_count: 0 };
    return {
      failed_count: Number(row.failed),
      total_count: Number(row.total),
    };
  } catch (error) {
    console.error('getN8nFailures24h failed:', error);
    return null;
  }
}

export async function getCloudSpendLastHour(): Promise<number | null> {
  const db = getKysely();
  try {
    const r = await db
      .selectFrom('drafts')
      .select((eb) => eb.fn.sum<string>('cost_usd').as('total'))
      .where(sql<boolean>`created_at > now() - interval '1 hour'`)
      .where('draft_source', 'in', ['cloud', 'cloud_haiku'])
      .where('cost_usd', 'is not', null)
      .executeTakeFirstOrThrow();
    return Number(r.total ?? 0);
  } catch (error) {
    console.error('getCloudSpendLastHour failed:', error);
    return null;
  }
}

// STAQPRO-192 — rolling 7-day edit-rate. The denominator is "drafts the
// operator actually disposed of" (approved + edited + sent), not raw
// draft count, so a backlog of pending drafts doesn't suppress the rate.
//
// Returned shape:
//   - edit_rate is null when sample_size = 0 (avoid 0/0 in the response)
//   - sample_size is always defined so callers know how stable the rate is
//
// Decision criteria for RAG help / hurt live in lib/rag/eval-baseline.ts.
export interface EditRate7d {
  edit_rate: number | null;
  sample_size: number;
}

export async function getEditRate7d(): Promise<EditRate7d> {
  const db = getKysely();
  const r = await sql<{ edited: string; disposed: string }>`
    SELECT
      COUNT(*) FILTER (WHERE status = 'edited')::text AS edited,
      COUNT(*) FILTER (WHERE status IN ('approved','edited','sent'))::text AS disposed
    FROM mailbox.drafts
    WHERE updated_at > NOW() - INTERVAL '7 days'
  `.execute(db);
  const row = r.rows[0];
  if (!row) return { edit_rate: null, sample_size: 0 };
  const edited = Number(row.edited);
  const disposed = Number(row.disposed);
  return {
    edit_rate: disposed > 0 ? edited / disposed : null,
    sample_size: disposed,
  };
}

export async function getDraftCounts24h(): Promise<DraftCounts24h> {
  const db = getKysely();
  const rows = await db
    .selectFrom('drafts')
    .select((eb) => [eb.ref('status').as('status'), eb.fn.countAll<string>().as('c')])
    .where(sql<boolean>`created_at > now() - interval '24 hours'`)
    .groupBy('status')
    .execute();

  const counts: DraftCounts24h = { total: 0, sent: 0, failed: 0, pending: 0, rejected: 0 };
  for (const row of rows) {
    const c = Number(row.c);
    counts.total += c;
    if (row.status === 'sent') counts.sent = c;
    else if (row.status === 'failed') counts.failed = c;
    else if (row.status === 'pending' || row.status === 'awaiting_cloud') counts.pending += c;
    else if (row.status === 'rejected') counts.rejected = c;
  }
  return counts;
}

// MBOX-185 — "sends needing attention" count. drafts.status='failed' is a dead
// stat (migration 016 dropped 'failed' from the CHECK; send-side failures leave
// the row at 'approved' per root CLAUDE.md), so the digest must NOT source send
// trouble from there. The live signal is the same one the dashboard's
// StuckApproved banner surfaces: rows still at status='approved' after a send
// was attempted (the migration-025 idempotency lock stamped send_attempt_at).
// A successful Mark Sent flips status='sent' AND clears send_attempt_at, so a
// row matching this predicate is one where Gmail Reply errored or n8n hung
// mid-send — exactly "needs the operator to verify in Gmail Sent and retry".
// Point-in-time (not 24h-windowed) to match the banner, which surfaces every
// stuck row regardless of age. Uses the partial index
// idx_drafts_send_attempt_at (WHERE send_attempt_at IS NOT NULL).
export async function getStuckApprovedCount(): Promise<number> {
  const db = getKysely();
  const r = await db
    .selectFrom('drafts')
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .where('status', '=', 'approved')
    .where('send_attempt_at', 'is not', null)
    .executeTakeFirstOrThrow();
  return Number(r.c);
}

// Audit 2026-05-15: per-job observability for in-process sweepers.
// Feeds /api/system/status (FR-29) so the operator sees the last run +
// failure count per job without SSHing to logs.
export interface JobHealthRow {
  job_name: string;
  last_run_at: string | null;
  last_status: 'completed' | 'partial' | 'failed' | 'skipped' | null;
  last_duration_ms: number | null;
  last_rows_processed: number | null;
  last_error_message: string | null;
  failed_count_24h: number;
}

export async function getJobHealth(): Promise<JobHealthRow[]> {
  const db = getKysely();
  // DISTINCT ON is the simplest "latest per group" idiom in Postgres and
  // lines up with the (job_name, started_at DESC) index from migration 024.
  const rows = await sql<{
    job_name: string;
    last_run_at: string | null;
    last_status: 'completed' | 'partial' | 'failed' | 'skipped' | null;
    last_duration_ms: number | null;
    last_rows_processed: number | null;
    last_error_message: string | null;
    failed_count_24h: string;
  }>`
    WITH latest AS (
      SELECT DISTINCT ON (job_name)
        job_name, finished_at AS last_run_at, status AS last_status,
        duration_ms AS last_duration_ms, rows_processed AS last_rows_processed,
        error_message AS last_error_message
      FROM mailbox.job_runs
      ORDER BY job_name, started_at DESC
    ),
    failures AS (
      SELECT job_name, COUNT(*)::text AS failed_count_24h
      FROM mailbox.job_runs
      WHERE finished_at > NOW() - INTERVAL '24 hours'
        AND status IN ('partial', 'failed')
      GROUP BY job_name
    )
    SELECT
      l.job_name,
      l.last_run_at::text AS last_run_at,
      l.last_status,
      l.last_duration_ms,
      l.last_rows_processed,
      l.last_error_message,
      COALESCE(f.failed_count_24h, '0') AS failed_count_24h
    FROM latest l
    LEFT JOIN failures f ON f.job_name = l.job_name
    ORDER BY l.job_name
  `.execute(db);

  return rows.rows.map((r) => ({
    job_name: r.job_name,
    last_run_at: r.last_run_at,
    last_status: r.last_status,
    last_duration_ms: r.last_duration_ms,
    last_rows_processed: r.last_rows_processed,
    last_error_message: r.last_error_message,
    failed_count_24h: Number(r.failed_count_24h),
  }));
}
