// STAQPRO-233 (KB Phase 0) — Drafting routes card — extracted from page.tsx.
// Renders local% vs cloud% over the last 7 days plus per-category edit rate
// (top 5 by volume). Powers the cloud-rate trend signal that gates STAQPRO-234
// success.

import type { DraftingMetrics } from '@/lib/queries-status';
import { Card } from './Primitives';

export function DraftingRoutesCard({ metrics }: { metrics: DraftingMetrics | null }) {
  if (metrics === null) {
    return (
      <Card>
        <p className="text-sm text-ink-dim">unavailable — view read failed</p>
      </Card>
    );
  }
  const { routes, by_category } = metrics;
  const fmtPct = (n: number | null): string => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);
  const top5 = by_category.slice(0, 5);
  const cloudHigh = routes.cloud_pct !== null && routes.cloud_pct > 0.25;
  return (
    <Card>
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-dim">Local</div>
          <div className="mt-1 font-mono text-2xl font-semibold tracking-tight text-accent-green">
            {fmtPct(routes.local_pct)}
          </div>
          <div className="mt-1 text-xs text-ink-dim">{routes.local_count} drafts</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-dim">Cloud</div>
          <div
            className={`mt-1 font-mono text-2xl font-semibold tracking-tight ${
              cloudHigh ? 'text-accent-orange' : 'text-ink'
            }`}
          >
            {fmtPct(routes.cloud_pct)}
          </div>
          <div className="mt-1 text-xs text-ink-dim">
            {routes.cloud_count} drafts{cloudHigh ? ' · target < 25%' : ''}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-dim">Disposed</div>
          <div className="mt-1 font-mono text-2xl font-semibold tracking-tight">
            {routes.total_count}
          </div>
          <div className="mt-1 text-xs text-ink-dim">approved + edited + sent + rejected</div>
        </div>
      </div>

      {top5.length > 0 ? (
        <div className="mt-4 border-t border-border-subtle pt-3">
          <div className="mb-2 text-xs uppercase tracking-wider text-ink-dim">
            Top categories by volume — edit rate
          </div>
          <ul className="space-y-1 font-mono text-xs">
            {top5.map((c) => {
              const high = c.edit_rate !== null && c.edit_rate > 0.4;
              return (
                <li key={c.classification_category} className="flex items-baseline justify-between">
                  <span className="text-ink-muted">{c.classification_category}</span>
                  <span className={high ? 'text-accent-orange' : 'text-ink'}>
                    {fmtPct(c.edit_rate)} <span className="text-ink-dim">({c.volume})</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="mt-4 border-t border-border-subtle pt-3 text-xs text-ink-dim">
          Not enough disposed drafts in the last 7 days to break out by category.
        </p>
      )}
      <p className="mt-3 text-xs text-ink-dim">
        Source-of-truth: <code className="font-mono">mailbox.v_drafting_metrics</code>. STAQPRO-233.
      </p>
    </Card>
  );
}
