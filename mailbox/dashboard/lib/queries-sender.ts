// dashboard/lib/queries-sender.ts
//
// STAQPRO-331 #6 — per-counterparty acceptance stats for the Sender history
// panel in DraftDetail. Counts inbound messages, draft outcomes, and the
// top reject reason over a configurable lookback window (default 30 days).
//
// "Sender" is normalized via normalizeSender so 'Name <a@b>' and 'a@b'
// collapse to the same key — matches the convention RAG ingestion uses
// (lib/rag/qdrant.ts). Without this, the badge would split stats per
// header variation.

import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import { normalizeSender } from '@/lib/rag/qdrant';
import type { RejectReasonCode } from '@/lib/types';

const DEFAULT_LOOKBACK_DAYS = 30;

export interface SenderHistory {
  sender: string;
  lookback_days: number;
  total_emails: number;
  drafts_approved: number;
  drafts_rejected: number;
  drafts_edited: number;
  drafts_sent: number;
  drafts_pending: number;
  mean_confidence: number | null;
  top_reject_reason: RejectReasonCode | null;
}

export async function getSenderHistory(
  senderRaw: string,
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS,
): Promise<SenderHistory | null> {
  const sender = normalizeSender(senderRaw);
  if (!sender) return null;

  const db = getKysely();
  const days = Math.max(1, Math.min(365, Math.trunc(lookbackDays) || DEFAULT_LOOKBACK_DAYS));

  // One round-trip — Postgres aggregates the message count + per-status
  // draft counts + mean confidence + top reject reason via subqueries.
  // ILIKE matches because inbox_messages.from_addr is stored as the raw
  // Gmail header (which may include display name), while we want the
  // bare normalized address as the match key.
  const row = await sql<{
    total_emails: string | null;
    drafts_approved: string | null;
    drafts_rejected: string | null;
    drafts_edited: string | null;
    drafts_sent: string | null;
    drafts_pending: string | null;
    mean_confidence: string | null;
    top_reject_reason: RejectReasonCode | null;
  }>`
    WITH window_msgs AS (
      SELECT m.id, m.confidence, m.draft_id
      FROM mailbox.inbox_messages m
      WHERE LOWER(m.from_addr) LIKE ${`%${sender}%`}
        AND m.created_at >= NOW() - (${days}::int * INTERVAL '1 day')
    ),
    window_drafts AS (
      SELECT d.id, d.status
      FROM mailbox.drafts d
      JOIN window_msgs wm ON wm.draft_id = d.id
    ),
    top_reason AS (
      SELECT df.reason_code
      FROM mailbox.draft_feedback df
      JOIN window_drafts wd ON wd.id = df.draft_id
      GROUP BY df.reason_code
      ORDER BY COUNT(*) DESC, df.reason_code ASC
      LIMIT 1
    )
    SELECT
      (SELECT COUNT(*) FROM window_msgs)::text AS total_emails,
      (SELECT COUNT(*) FROM window_drafts WHERE status = 'approved')::text AS drafts_approved,
      (SELECT COUNT(*) FROM window_drafts WHERE status = 'rejected')::text AS drafts_rejected,
      (SELECT COUNT(*) FROM window_drafts WHERE status = 'edited')::text AS drafts_edited,
      (SELECT COUNT(*) FROM window_drafts WHERE status = 'sent')::text AS drafts_sent,
      (SELECT COUNT(*) FROM window_drafts WHERE status IN ('pending', 'awaiting_cloud'))::text
        AS drafts_pending,
      (SELECT AVG(confidence)::text FROM window_msgs WHERE confidence IS NOT NULL)
        AS mean_confidence,
      (SELECT reason_code FROM top_reason) AS top_reject_reason
  `.execute(db);

  const r = row.rows[0];
  if (!r) {
    return {
      sender,
      lookback_days: days,
      total_emails: 0,
      drafts_approved: 0,
      drafts_rejected: 0,
      drafts_edited: 0,
      drafts_sent: 0,
      drafts_pending: 0,
      mean_confidence: null,
      top_reject_reason: null,
    };
  }
  return {
    sender,
    lookback_days: days,
    total_emails: toInt(r.total_emails),
    drafts_approved: toInt(r.drafts_approved),
    drafts_rejected: toInt(r.drafts_rejected),
    drafts_edited: toInt(r.drafts_edited),
    drafts_sent: toInt(r.drafts_sent),
    drafts_pending: toInt(r.drafts_pending),
    mean_confidence: r.mean_confidence != null ? Number.parseFloat(r.mean_confidence) : null,
    top_reject_reason: r.top_reject_reason,
  };
}

function toInt(v: string | null): number {
  if (v == null) return 0;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

// ──────────────────────────────────────────────────────────────────────────
// MBOX-367 (MBOX-162 V4) — cross-account intelligence.
//
// The structural moat a multi-tenant cloud SaaS can't match: surface, for one
// counterparty, the inboxes *other than the current one* they've also reached
// ("emailed your consulting address last month and your founder address
// today"). All account-scoped tables carry account_id since migration 033, so
// this is pure query — no migration. Inert on a single-account appliance (there
// are no "other" accounts), so the route short-circuits before this runs.
//
// Longer default window than getSenderHistory (90d vs 30d): the value of
// cross-account recall is the *long-memory* link across identities, not the
// recent-acceptance signal the per-sender panel already covers.
// ──────────────────────────────────────────────────────────────────────────

const CROSS_ACCOUNT_LOOKBACK_DAYS = 90;

export interface CrossAccountSenderRow {
  account_id: number;
  account_email: string;
  account_label: string | null;
  total_emails: number;
  drafts_sent: number;
  last_seen_at: string | null;
}

export async function getSenderAcrossAccounts(
  senderRaw: string,
  excludeAccountId: number,
  lookbackDays: number = CROSS_ACCOUNT_LOOKBACK_DAYS,
): Promise<CrossAccountSenderRow[]> {
  const sender = normalizeSender(senderRaw);
  if (!sender) return [];

  const db = getKysely();
  const days = Math.max(1, Math.min(365, Math.trunc(lookbackDays) || CROSS_ACCOUNT_LOOKBACK_DAYS));

  // One round-trip: group this counterparty's inbound by owning account,
  // excluding the draft's own account. drafts_sent joins through the
  // inbox_messages.draft_id denorm (migration 021) like getSenderHistory.
  const res = await sql<{
    account_id: number;
    account_email: string;
    account_label: string | null;
    total_emails: string;
    drafts_sent: string;
    last_seen_at: string | null;
  }>`
    WITH window_msgs AS (
      SELECT m.id, m.account_id, m.draft_id,
             COALESCE(m.received_at, m.created_at) AS seen_at
      FROM mailbox.inbox_messages m
      WHERE LOWER(m.from_addr) LIKE ${`%${sender}%`}
        AND m.created_at >= NOW() - (${days}::int * INTERVAL '1 day')
        AND m.account_id <> ${excludeAccountId}
    )
    SELECT
      a.id AS account_id,
      a.email_address AS account_email,
      a.display_label AS account_label,
      COUNT(wm.id)::text AS total_emails,
      COUNT(d.id) FILTER (WHERE d.status = 'sent')::text AS drafts_sent,
      MAX(wm.seen_at)::text AS last_seen_at
    FROM window_msgs wm
    JOIN mailbox.accounts a ON a.id = wm.account_id
    LEFT JOIN mailbox.drafts d ON d.id = wm.draft_id
    GROUP BY a.id, a.email_address, a.display_label
    ORDER BY MAX(wm.seen_at) DESC
  `.execute(db);

  return res.rows.map((r) => ({
    account_id: r.account_id,
    account_email: r.account_email,
    account_label: r.account_label,
    total_emails: toInt(r.total_emails),
    drafts_sent: toInt(r.drafts_sent),
    last_seen_at: r.last_seen_at,
  }));
}
