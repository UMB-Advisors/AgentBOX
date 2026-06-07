import { sql } from 'kysely';
import { gatherFiringAlerts } from '@/lib/alert-inputs';
import type { Alert } from '@/lib/alerts';
import { operatorOwnsThread } from '@/lib/classification/thread-ownership';
import { getKysely } from '@/lib/db';
import { getQueueWithUrgency } from '@/lib/queries';
import { type AwaitingReplyItem, getAwaitingReply } from '@/lib/queries-followup';
import { getDraftCounts24h, getStuckApprovedCount } from '@/lib/queries-system';
import type { ClassificationCategory, DraftStatus, UrgencySignal } from '@/lib/types';

// MBOX-132 — daily digest payload query. Assembles the once-per-day operator
// digest body from the live queue: a count by category, the urgent-untouched
// list (reusing MBOX-134's urgency engine so the digest's "needs your eyes"
// section matches the dashboard's red-flag exactly), and the oldest-pending
// tail. Pure read; no writes. The HTML renderer (lib/digest/render.ts) and the
// decision route (app/api/internal/digest/route.ts) consume this.
//
// Reuse note: urgent_untouched is derived from getQueueWithUrgency (lib/
// queries.ts) — the same SQL urgency surface the dashboard ships — so there is
// ONE urgency rule SoT (lib/urgency.ts:evaluateUrgency mirrored set-wise in
// SQL). The digest does not re-implement urgency.

// The "queue" slice the digest reports on — operator-actionable drafts. Matches
// getQueueWithUrgency's default (pending + edited): rows still awaiting the
// operator. 'sent'/'approved'/'rejected' are out of the digest's scope.
const QUEUE_STATUSES: DraftStatus[] = ['pending', 'edited'];

// A single draft as it appears in the digest body. Lean projection — just what
// the email renders (no thread history, no full body). `age_hours` is rounded
// to one decimal for display; `signals` is populated only on urgent rows.
export interface DigestDraftItem {
  draft_id: number;
  from_addr: string | null;
  subject: string | null;
  snippet: string | null;
  category: ClassificationCategory | null;
  age_hours: number;
  signals: UrgencySignal[];
}

export interface CategoryCount {
  category: ClassificationCategory | null;
  count: number;
}

// MBOX-185 (FR-22) — the digest's health block. sent_24h answers "did the box
// actually send for me yesterday?"; stuck_approved is the count of sends that
// need the operator's attention — rows still at status='approved' after a send
// was attempted (NOT drafts.status='failed', which is a dead stat: migration
// 016 dropped 'failed' from the CHECK and send-side failures leave the row at
// 'approved' per root CLAUDE.md). It's the same signal the dashboard's
// StuckApproved banner surfaces, so the digest and the UI agree on "stuck after
// send attempt". firing_alerts is the SAME evaluateAlerts output the /status
// page and the email push path use (memory / swap / classify-lag /
// gmail-cooldown / disk-free etc.) so the digest does NOT run a second stats
// engine — it renders whatever is currently red/amber.
export interface DigestHealth {
  sent_24h: number;
  stuck_approved: number;
  firing_alerts: Alert[];
}

export interface DigestPayload {
  // Count of queue drafts grouped by classification_category, descending by
  // count. Drives the "pending by category" headline + section.
  counts_by_category: CategoryCount[];
  // Urgent drafts still awaiting the operator (any urgency signal fired), newest
  // urgency-first. Drives the red "needs your eyes" section.
  urgent_untouched: DigestDraftItem[];
  // The oldest pending drafts (FIFO — what's been waiting longest), capped.
  // Drives the "oldest waiting" tail so nothing rots silently in the queue.
  oldest_pending: DigestDraftItem[];
  // MBOX-377 — outbound replies we sent that have gone quiet (no inbound since
  // our send, past the per-category follow-up threshold), operator-owned threads
  // excluded. Drives the "Awaiting reply" section. Distinct from the queue lists
  // above: these threads are already SENT, not pending.
  awaiting_reply: AwaitingReplyItem[];
  // FR-22 health rollup — sent count, send failures, and currently-firing
  // health alerts. Drives the "Appliance health" section.
  health: DigestHealth;
}

export interface DigestPayloadOptions {
  // Cap on each list. Defaults keep the email glanceable on a phone.
  urgentLimit?: number;
  oldestLimit?: number;
  awaitingLimit?: number;
  // Injected for tests; defaults to process.env (urgency + follow-up thresholds).
  env?: Record<string, string | undefined>;
}

const DEFAULT_URGENT_LIMIT = 10;
const DEFAULT_OLDEST_LIMIT = 10;
const DEFAULT_AWAITING_LIMIT = 10;

function clampLimit(v: number | undefined, fallback: number): number {
  return Math.min(Math.max(Math.trunc(v ?? fallback) || fallback, 1), 50);
}

export async function getDigestPayload(opts: DigestPayloadOptions = {}): Promise<DigestPayload> {
  const env = opts.env ?? process.env;
  const urgentLimit = clampLimit(opts.urgentLimit, DEFAULT_URGENT_LIMIT);
  const oldestLimit = clampLimit(opts.oldestLimit, DEFAULT_OLDEST_LIMIT);
  const awaitingLimit = clampLimit(opts.awaitingLimit, DEFAULT_AWAITING_LIMIT);
  const db = getKysely();

  // counts_by_category — one set-based GROUP BY over the queue slice.
  const countRows = await db
    .selectFrom('drafts as d')
    .where('d.status', 'in', QUEUE_STATUSES)
    .select((eb) => ['d.classification_category as category', eb.fn.countAll<string>().as('count')])
    .groupBy('d.classification_category')
    .orderBy('count', 'desc')
    .execute();

  const counts_by_category: CategoryCount[] = countRows.map((r) => ({
    category: (r.category as ClassificationCategory | null) ?? null,
    count: Number(r.count),
  }));

  // urgent_untouched — reuse the urgency SQL surface, then keep only urgent rows
  // and project to the lean digest item shape. getQueueWithUrgency caps its own
  // fetch; we slice to urgentLimit after filtering so the cap is on URGENT rows,
  // not on the pre-filter fetch. Fetch the full queue (cap 200) so the urgent
  // filter sees everything.
  const queue = await getQueueWithUrgency(QUEUE_STATUSES, 200, env);
  const urgent_untouched: DigestDraftItem[] = queue
    .filter((row) => row.urgency.urgent)
    .slice(0, urgentLimit)
    .map((row) => ({
      draft_id: row.id,
      from_addr: row.message.from_addr,
      subject: row.message.subject ?? row.draft_subject,
      snippet: row.message.snippet,
      // The draft's classification_category isn't on the curated Draft view;
      // read the message-level denormalized classification (kept in sync from
      // classification_log per CLAUDE.md). Same enum domain.
      category: (row.message.classification as ClassificationCategory | null) ?? null,
      age_hours: ageHoursFrom(row.created_at),
      signals: row.urgency.signals,
    }));

  // oldest_pending — the FIFO tail. Only 'pending' (not 'edited' — an edited
  // draft has already been touched by the operator, so it's not "waiting
  // untouched"). Oldest created_at first.
  const oldestRows = await db
    .selectFrom('drafts as d')
    .innerJoin('inbox_messages as m', 'd.inbox_message_id', 'm.id')
    .where('d.status', '=', 'pending')
    .select([
      'd.id as draft_id',
      'd.classification_category as category',
      'd.created_at as created_at',
      'm.from_addr as from_addr',
      'm.subject as subject',
      'm.snippet as snippet',
      sql<number>`EXTRACT(EPOCH FROM (NOW() - d.created_at)) / 3600.0`.as('age_hours_raw'),
    ])
    .orderBy('d.created_at', 'asc')
    .limit(oldestLimit)
    .execute();

  const oldest_pending: DigestDraftItem[] = oldestRows.map((r) => ({
    draft_id: r.draft_id,
    from_addr: r.from_addr,
    subject: r.subject,
    snippet: r.snippet,
    category: (r.category as ClassificationCategory | null) ?? null,
    age_hours: roundHours(Number(r.age_hours_raw)),
    signals: [],
  }));

  // awaiting_reply — outbound threads gone quiet (MBOX-377). Fetch a few more
  // candidates than the cap so the operator-owns-thread guard (MBOX-142) can
  // drop owned threads without starving the list, then cap. The guard does
  // per-thread DB work but the candidate set is bounded and this is a
  // once-per-day render. operatorOwnsThread fail-opens (owned:false on error),
  // so an infra hiccup surfaces the thread rather than hiding it.
  const awaitingCandidates = await getAwaitingReply({ env, limit: awaitingLimit * 3 });
  const awaiting_reply: AwaitingReplyItem[] = [];
  for (const item of awaitingCandidates) {
    if (awaiting_reply.length >= awaitingLimit) break;
    const ownership = await operatorOwnsThread({ thread_id: item.thread_id });
    if (!ownership.owned) awaiting_reply.push(item);
  }

  const health = await getDigestHealth();

  return { counts_by_category, urgent_untouched, oldest_pending, awaiting_reply, health };
}

// MBOX-185 (FR-22) — digest health rollup. sent_24h comes from
// getDraftCounts24h; stuck_approved from getStuckApprovedCount (the live
// "sends needing attention" signal — see that helper for why status='failed'
// is NOT used). gatherFiringAlerts is the shared evaluateAlerts surface the
// /status page and the alert push path use, so the digest reports the same
// numbers everywhere. Fails closed: a failed sub-fetch degrades to zero / no
// alerts rather than failing the whole digest render.
export async function getDigestHealth(): Promise<DigestHealth> {
  const [counts, stuck_approved, firing_alerts] = await Promise.all([
    getDraftCounts24h().catch(() => ({ sent: 0 })),
    getStuckApprovedCount().catch(() => 0),
    gatherFiringAlerts().catch(() => [] as Alert[]),
  ]);
  return {
    sent_24h: counts.sent,
    stuck_approved,
    firing_alerts,
  };
}

// ── digest_sends ledger (migration 029) — once-per-day de-dupe guard ────────
//
// recordDigestSendIfFirstToday is the idempotency primitive. It attempts an
// INSERT ... ON CONFLICT (sent_on) DO NOTHING; the constraint
// (digest_sends_sent_on_uniq) makes the second call for the same local day a
// no-op. Returns true when THIS call won the day (a row was inserted → safe to
// send), false when the day was already claimed (skip — already sent). The race
// is resolved in Postgres, so concurrent schedule ticks / operator re-fires
// cannot both win.

export interface DigestSendRecord {
  sent_on: string; // YYYY-MM-DD local day
  recipient: string | null;
  subject: string | null;
}

export async function recordDigestSendIfFirstToday(rec: DigestSendRecord): Promise<boolean> {
  const db = getKysely();
  const row = await db
    .insertInto('digest_sends')
    .values({
      sent_on: rec.sent_on,
      recipient: rec.recipient,
      subject: rec.subject,
    })
    .onConflict((oc) => oc.column('sent_on').doNothing())
    .returning('id')
    .executeTakeFirst();
  // executeTakeFirst returns undefined when ON CONFLICT DO NOTHING suppressed
  // the insert (the day was already claimed). A defined row → we claimed it.
  return row !== undefined;
}

// Read-only check used by the render/decision route to report whether today's
// digest has already been sent WITHOUT claiming the day (the actual claim
// happens via recordDigestSendIfFirstToday after the send). Lets the route
// answer "should_send" before n8n fires Gmail.
export async function hasDigestSentOn(sentOn: string): Promise<boolean> {
  const db = getKysely();
  const row = await db
    .selectFrom('digest_sends')
    .select('id')
    .where('sent_on', '=', sentOn)
    .executeTakeFirst();
  return row !== undefined;
}

// created_at is a TIMESTAMPTZ surfaced as an ISO string (pg type-parser
// override). Compute age in hours against now, rounded to one decimal.
function ageHoursFrom(createdAt: string): number {
  const ms = Date.now() - new Date(createdAt).getTime();
  return roundHours(ms / (1000 * 60 * 60));
}

function roundHours(h: number): number {
  return Math.round(Math.max(h, 0) * 10) / 10;
}
