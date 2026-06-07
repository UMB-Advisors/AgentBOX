'use client';

import { useEffect, useState } from 'react';
import { type Freshness, formatDuration, freshnessFor } from '@/lib/freshness';

// STAQPRO-331 #8 — color-coded freshness chip for a draft's created_at.
// Thresholds (see lib/freshness.ts):
//   < 15 min      → green "fresh"
//   15 min – 2 h  → neutral (no chip background, just relative time)
//   2 h – 8 h     → amber "stale"
//   > 8 h         → red "overdue"
//
// Refreshes every 60s like TimeAgo so the chip color advances as the
// draft ages without a full page reload. Label is intentionally short
// ("12m", "3h", "stale 4h", "overdue 1d") to fit the compact DraftCard.

export function FreshnessChip({ iso }: { iso: string | null }) {
  const [diffMs, setDiffMs] = useState<number | null>(null);

  useEffect(() => {
    if (!iso) return;
    const update = () => setDiffMs(Date.now() - new Date(iso).getTime());
    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, [iso]);

  if (!iso) return <span className="text-ink-dim">—</span>;
  if (diffMs == null)
    return (
      <span aria-hidden className="text-ink-dim">
        ·
      </span>
    );

  const freshness = freshnessFor(diffMs);
  const time = formatDuration(diffMs);
  const palette = PALETTE[freshness];
  const label =
    freshness === 'fresh'
      ? 'fresh'
      : freshness === 'stale'
        ? `stale ${time}`
        : freshness === 'overdue'
          ? `overdue ${time}`
          : time;

  if (freshness === 'neutral') {
    return <span className="font-mono text-[11px] text-ink-dim">{label}</span>;
  }
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 font-mono text-[10px] ${palette}`}
      title={`Draft created ${time} ago`}
    >
      {label}
    </span>
  );
}

const PALETTE: Record<Freshness, string> = {
  fresh: 'border-accent-green/40 bg-accent-green/10 text-accent-green',
  neutral: '',
  stale: 'border-accent-orange/40 bg-accent-orange/10 text-accent-orange',
  overdue: 'border-accent-red/40 bg-accent-red/10 text-accent-red',
};
