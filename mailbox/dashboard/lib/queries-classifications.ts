import { sql } from 'kysely';
import { CLOUD_CATEGORIES, LOCAL_CATEGORIES } from '@/lib/classification/prompt';
import { getKysely } from '@/lib/db';

// STAQPRO-147 — operator visibility view: every classified inbound message
// joined to its inbox row + (optional) draft outcome. Ordered most-recent
// first; capped at 200 to keep the table render cheap on 8GB Jetson.

export type ClassificationRoute = 'drop' | 'local' | 'cloud';
export type DraftOutcome =
  | 'pending'
  | 'approved'
  | 'sent'
  | 'rejected'
  | 'edited'
  | 'failed'
  | null;

export interface ClassificationRow {
  log_id: string; // bigserial → string
  classified_at: string;
  inbox_message_id: number;
  from_addr: string | null;
  subject: string | null;
  category: string;
  confidence: number;
  model_version: string;
  latency_ms: number | null;
  route: ClassificationRoute;
  draft_id: number | null;
  draft_status: DraftOutcome;
  draft_sent_at: string | null;
}

export interface ListOpts {
  limit?: number;
  category?: string | null;
  route?: ClassificationRoute | null;
  minConfidence?: number | null;
  maxConfidence?: number | null;
}

export async function listClassifications(opts: ListOpts = {}): Promise<ClassificationRow[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100) || 100, 1), 200);
  const db = getKysely();

  let q = db
    .selectFrom('classification_log as c')
    .innerJoin('inbox_messages as m', 'c.inbox_message_id', 'm.id')
    .leftJoin('drafts as d', 'd.inbox_message_id', 'm.id')
    .select([
      sql<string>`c.id::text`.as('log_id'),
      sql<string>`c.created_at`.as('classified_at'),
      'c.inbox_message_id as inbox_message_id',
      'm.from_addr as from_addr',
      'm.subject as subject',
      'c.category as category',
      'c.confidence as confidence',
      'c.model_version as model_version',
      'c.latency_ms as latency_ms',
      'd.id as draft_id',
      sql<DraftOutcome>`d.status`.as('draft_status'),
      'd.sent_at as draft_sent_at',
    ])
    .orderBy('c.created_at', 'desc')
    .limit(limit);

  if (opts.category) {
    q = q.where('c.category', '=', opts.category);
  }
  if (opts.minConfidence != null) {
    q = q.where('c.confidence', '>=', opts.minConfidence);
  }
  if (opts.maxConfidence != null) {
    q = q.where('c.confidence', '<=', opts.maxConfidence);
  }

  const rows = await q.execute();
  return rows
    .map((r) => ({
      ...(r as Omit<ClassificationRow, 'route'>),
      route: deriveRoute(r.category, r.confidence),
    }))
    .filter((r) => (opts.route ? r.route === opts.route : true));
}

// Mirror of dashboard/lib/classification/prompt.ts:routeFor + the drafting
// router's spam-drop short-circuit. Kept inline so a single SELECT can return
// the route without a function-per-row plpgsql call.
function deriveRoute(category: string, confidence: number): ClassificationRoute {
  if (category === 'spam_marketing') return 'drop';
  if (confidence < 0.75) return 'cloud';
  if ((LOCAL_CATEGORIES as readonly string[]).includes(category)) return 'local';
  if ((CLOUD_CATEGORIES as readonly string[]).includes(category)) return 'cloud';
  return 'cloud';
}
