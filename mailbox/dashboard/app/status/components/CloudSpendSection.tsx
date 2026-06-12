// Cloud spend (last 24h) section. Extracted from status/page.tsx.

import type { CloudSpend24h } from '@/lib/queries-system';
import { Card } from './Primitives';

interface CloudSpendSectionProps {
  cloudSpend24h: CloudSpend24h | null;
}

export function CloudSpendSection({ cloudSpend24h }: CloudSpendSectionProps) {
  return (
    <section className="mb-6">
      <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
        Cloud spend (last 24h)
      </h2>
      <Card>
        {cloudSpend24h === null ? (
          <p className="text-sm text-ink-dim">unavailable</p>
        ) : (
          <>
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-2xl font-semibold tracking-tight">
                ${cloudSpend24h.total_usd.toFixed(4)}
              </span>
              <span className="text-sm text-ink-muted">
                over {cloudSpend24h.call_count} cloud-route call
                {cloudSpend24h.call_count === 1 ? '' : 's'}
              </span>
            </div>
            <p className="mt-1 text-xs text-ink-dim">
              Source-of-truth: <code className="font-mono">mailbox.drafts.cost_usd</code> summed
              where <code className="font-mono">draft_source</code> went via cloud (Ollama Cloud
              primary, Anthropic alt). Local Qwen3 calls excluded — they cost $0 on-device.
            </p>
            {Object.keys(cloudSpend24h.by_source).length > 0 && (
              <ul className="mt-3 space-y-1 text-xs">
                {Object.entries(cloudSpend24h.by_source).map(([source, stats]) => (
                  <li key={source} className="flex justify-between font-mono">
                    <span className="text-ink-muted">{source}</span>
                    <span>
                      ${stats.total_usd.toFixed(4)} ({stats.call_count})
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
