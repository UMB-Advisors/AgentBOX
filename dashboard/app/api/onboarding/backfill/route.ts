import { sql } from 'kysely';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseJson } from '@/lib/middleware/validate';
import { runGmailHistoryBackfill } from '@/lib/onboarding/gmail-history-backfill';
import { onboardingBackfillRequestSchema } from '@/lib/schemas/onboarding';

export const dynamic = 'force-dynamic';
// Backfill can run for several minutes against larger mailboxes; explicit
// long timeout so the App Router default doesn't 504 on us.
export const maxDuration = 600;

// Postgres advisory-lock key, derived from the ticket number to keep it
// stable + unique. pg_try_advisory_lock returns immediately (no wait) so
// the second concurrent caller gets a clean 409 instead of a long hang.
// Survives process restart since locks live in Postgres's shared memory
// for the session that holds them — when the dashboard process dies the
// lock is auto-released.
const BACKFILL_LOCK_KEY = 193;

// STAQPRO-193 — Gmail Sent backfill HTTP entry point. Operator-facing,
// inherits Caddy basic_auth via the existing /api/* matcher. Per Locked
// Decision #3, the CLI (`npm run onboarding:backfill`) is the canonical
// production surface — this route is the thin hook so the M4 onboarding
// wizard can fire backfill in one call without re-implementing the
// orchestration.
//
// Body: { days_lookback?: number = 180, max_messages?: number }
// Response: { ok: true, counts: BackfillCounts } on success.
//
// MAILBOX_OPERATOR_EMAIL must be set in the environment — it identifies
// which messages in each thread are "my reply". A missing env returns 500
// with a structured error so the wizard can surface a clear failure.

export async function POST(req: NextRequest): Promise<Response> {
  const parsed = await parseJson(req, onboardingBackfillRequestSchema);
  if (!parsed.ok) return parsed.response;

  const operatorEmail = process.env.MAILBOX_OPERATOR_EMAIL;
  if (!operatorEmail) {
    return NextResponse.json(
      {
        ok: false,
        error: 'misconfigured',
        message: 'MAILBOX_OPERATOR_EMAIL must be set in the dashboard service env',
      },
      { status: 500 },
    );
  }

  const fetchHistoryUrl =
    process.env.MAILBOX_FETCH_HISTORY_URL ?? 'http://n8n:5678/webhook/mailbox-fetch-history';
  const envMax = Number(process.env.RAG_BACKFILL_MAX_MESSAGES ?? 5000);
  const max_messages = parsed.data.max_messages ?? envMax;

  const startedAt = Date.now();
  const db = getKysely();

  // Concurrency guard: two simultaneous 5K-thread backfills would saturate
  // the Jetson's ~2.3GB headroom over Qwen3 and risk OOM. Advisory lock
  // returns immediately so a double-click on the onboarding wizard gets a
  // clean 409 instead of a lengthy hang.
  const lockRow = await sql<{
    locked: boolean;
  }>`SELECT pg_try_advisory_lock(${BACKFILL_LOCK_KEY}) AS locked`.execute(db);
  const acquired = lockRow.rows[0]?.locked === true;
  if (!acquired) {
    return NextResponse.json(
      {
        ok: false,
        error: 'already_running',
        message: 'A Gmail history backfill is already in progress on this appliance',
      },
      { status: 409 },
    );
  }

  try {
    const counts = await runGmailHistoryBackfill(
      {
        days_lookback: parsed.data.days_lookback,
        max_messages,
        operator_email: operatorEmail,
        fetch_history_url: fetchHistoryUrl,
      },
      { db },
    );
    return NextResponse.json({
      ok: true,
      days_lookback: parsed.data.days_lookback,
      max_messages,
      elapsed_ms: Date.now() - startedAt,
      counts,
    });
  } catch (err) {
    console.error('POST /api/onboarding/backfill failed:', err);
    return NextResponse.json(
      {
        ok: false,
        error: 'backfill_failed',
        message: err instanceof Error ? err.message : 'unknown',
        elapsed_ms: Date.now() - startedAt,
      },
      { status: 502 },
    );
  } finally {
    await sql`SELECT pg_advisory_unlock(${BACKFILL_LOCK_KEY})`.execute(db);
  }
}
