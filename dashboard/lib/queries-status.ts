// STAQPRO-233 (KB Phase 0) — drafting telemetry queries.
//
// Reads from the read-only views created by migration 019:
//   - mailbox.v_drafting_metrics  (day × source × category × status, COUNT(*))
//   - mailbox.v_override_rate     (category × source, edit_reject_rate over 14d)
//
// Two consumers today:
//   1. /status page "Drafting routes (last 7d)" card — getDraftingMetrics(7).
//   2. STAQPRO-235's /settings/kb nudge UI — getTopEditRateCategories(14, 3).
//
// All helpers fail closed: on error, return shape-stable empty/null data so
// the /status page never 500s on a transient view-read error. Same convention
// as queries-system.ts.

import { sql } from 'kysely';
import { getKysely } from '@/lib/db';

// ── getDraftingMetrics ──────────────────────────────────────────────────────

export interface DraftingRouteSplit {
  // local% / cloud% of disposed drafts (approved + edited + sent + rejected).
  // Pending / awaiting_cloud are excluded — they aren't a route outcome yet.
  local_count: number;
  cloud_count: number;
  total_count: number;
  local_pct: number | null; // null when total_count === 0
  cloud_pct: number | null;
}

export interface CategoryEditRate {
  classification_category: string;
  volume: number; // disposed count over the window
  edit_rate: number | null; // null when volume === 0
  edited: number;
  rejected: number;
}

export interface DraftingMetrics {
  window_days: number;
  routes: DraftingRouteSplit;
  by_category: ReadonlyArray<CategoryEditRate>;
}

const EMPTY_METRICS = (window_days: number): DraftingMetrics => ({
  window_days,
  routes: {
    local_count: 0,
    cloud_count: 0,
    total_count: 0,
    local_pct: null,
    cloud_pct: null,
  },
  by_category: [],
});

/**
 * Get drafting metrics for the last `days` days (default 7).
 *
 * - `routes`: local vs cloud split of disposed drafts (approved/edited/sent/rejected).
 *   Counts 'cloud' + legacy 'cloud_haiku' as cloud; 'local' + legacy 'local_qwen3' as local.
 * - `by_category`: top categories by volume with their edit rate, sorted by volume DESC.
 *
 * Reads from `mailbox.v_drafting_metrics`. View is daily-grain so we filter
 * by `day >= current_date - <days>` and aggregate in TS.
 */
export async function getDraftingMetrics(days = 7): Promise<DraftingMetrics> {
  if (days <= 0) return EMPTY_METRICS(days);
  const db = getKysely();

  try {
    const rows = await db
      .selectFrom('v_drafting_metrics')
      .select([
        'draft_source',
        'classification_category',
        'status',
        sql<string>`SUM(n)::text`.as('n'),
      ])
      .where(sql<boolean>`day >= current_date - make_interval(days => ${days})`)
      .groupBy(['draft_source', 'classification_category', 'status'])
      .execute();

    let localCount = 0;
    let cloudCount = 0;
    const byCategory = new Map<string, { volume: number; edited: number; rejected: number }>();

    for (const row of rows) {
      const n = Number(row.n ?? 0);
      const source = row.draft_source;
      const status = row.status;
      const category = row.classification_category;

      // Routes: disposed only (approved | edited | sent | rejected). Pending /
      // awaiting_cloud aren't a route outcome — they haven't completed.
      const disposed =
        status === 'approved' || status === 'edited' || status === 'sent' || status === 'rejected';
      if (disposed) {
        if (source === 'cloud' || source === 'cloud_haiku') cloudCount += n;
        else if (source === 'local' || source === 'local_qwen3') localCount += n;
      }

      // Per-category aggregation. Skip null categories (very early rows).
      if (category && disposed) {
        const cur = byCategory.get(category) ?? { volume: 0, edited: 0, rejected: 0 };
        cur.volume += n;
        if (status === 'edited') cur.edited += n;
        if (status === 'rejected') cur.rejected += n;
        byCategory.set(category, cur);
      }
    }

    const total = localCount + cloudCount;
    const routes: DraftingRouteSplit = {
      local_count: localCount,
      cloud_count: cloudCount,
      total_count: total,
      local_pct: total > 0 ? localCount / total : null,
      cloud_pct: total > 0 ? cloudCount / total : null,
    };

    const by_category: CategoryEditRate[] = Array.from(byCategory.entries())
      .map(([classification_category, agg]) => ({
        classification_category,
        volume: agg.volume,
        edited: agg.edited,
        rejected: agg.rejected,
        edit_rate: agg.volume > 0 ? (agg.edited + agg.rejected) / agg.volume : null,
      }))
      .sort((a, b) => b.volume - a.volume);

    return { window_days: days, routes, by_category };
  } catch (error) {
    console.error('getDraftingMetrics failed:', error);
    return EMPTY_METRICS(days);
  }
}

// ── getTopEditRateCategories (consumed by STAQPRO-235 KB nudges) ────────────

export interface TopEditRateCategory {
  classification_category: string;
  edit_reject_rate: number; // 0..1
  disposed: number; // sample size
}

/**
 * Top N categories by edit/reject rate over the v_override_rate 14-day window.
 *
 * Filters out (category × source) combos with insufficient signal
 * (disposed < minSampleSize, default 5). Aggregates across draft_source so the
 * UI nudge speaks at the category level ("reorder drafts get edited a lot"),
 * not source level.
 *
 * Returns at most `limit` rows ordered by edit_reject_rate DESC. Empty array
 * when no category meets the sample-size floor — caller renders an empty-state.
 */
export async function getTopEditRateCategories(
  limit = 3,
  minSampleSize = 5,
): Promise<ReadonlyArray<TopEditRateCategory>> {
  if (limit <= 0) return [];
  const db = getKysely();

  try {
    // Re-aggregate v_override_rate over (source) so the surface is
    // category-only. The view's edit_reject_rate is per (cat × src), so we
    // recompute from the underlying counts.
    const rows = await db
      .selectFrom('v_override_rate')
      .select([
        'classification_category',
        sql<string>`SUM(edited)::text`.as('edited'),
        sql<string>`SUM(rejected)::text`.as('rejected'),
        sql<string>`SUM(disposed)::text`.as('disposed'),
      ])
      .groupBy('classification_category')
      .execute();

    // The v_override_rate view filters out `classification_category IS NULL`
    // rows at the SQL level (see migration 019), so the value is never null
    // at runtime. kysely-codegen still emits `string | null` because it
    // infers from the underlying `drafts.classification_category` column.
    // Narrow defensively here so the TopEditRateCategory.classification_category
    // contract holds without a type cast.
    const ranked = rows
      .filter(
        (r): r is typeof r & { classification_category: string } =>
          r.classification_category !== null,
      )
      .map((r) => {
        const edited = Number(r.edited ?? 0);
        const rejected = Number(r.rejected ?? 0);
        const disposed = Number(r.disposed ?? 0);
        const rate = disposed > 0 ? (edited + rejected) / disposed : 0;
        return {
          classification_category: r.classification_category,
          edit_reject_rate: rate,
          disposed,
        };
      })
      .filter((r) => r.disposed >= minSampleSize)
      .sort((a, b) => b.edit_reject_rate - a.edit_reject_rate)
      .slice(0, limit);

    return ranked;
  } catch (error) {
    console.error('getTopEditRateCategories failed:', error);
    return [];
  }
}
