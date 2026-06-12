// STAQPRO-192 — RAG eval card — extracted from page.tsx.
// Renders the frozen pre-RAG baseline next to the live 7-day edit-rate so the
// operator can see at a glance whether retrieval is helping.

import type { RagEvalSnapshot } from '@/lib/rag/eval-baseline';
import { Card } from './Primitives';

export function RagEvalCard({ snap }: { snap: RagEvalSnapshot }) {
  const fmtPct = (n: number | null): string => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);
  const baselineMissing = snap.baseline.edit_rate === null;
  return (
    <Card>
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-dim">Pre-RAG baseline</div>
          <div className="mt-1 font-mono text-2xl font-semibold tracking-tight">
            {fmtPct(snap.baseline.edit_rate)}
          </div>
          <div className="mt-1 text-xs text-ink-dim">
            {baselineMissing
              ? 'Pending capture — see lib/rag/eval-baseline.ts'
              : `n=${snap.baseline.sample_size ?? '—'} · captured ${snap.baseline.captured_at ?? '—'}`}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-dim">Live 7d</div>
          <div className="mt-1 font-mono text-2xl font-semibold tracking-tight">
            {fmtPct(snap.live_7d.edit_rate)}
          </div>
          <div className="mt-1 text-xs text-ink-dim">
            n={snap.live_7d.sample_size} (approved + edited + sent)
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-dim">Delta vs baseline</div>
          <div
            className={`mt-1 font-mono text-2xl font-semibold tracking-tight ${
              snap.delta.helping === true
                ? 'text-accent-green'
                : snap.delta.helping === false
                  ? 'text-accent-orange'
                  : 'text-ink-dim'
            }`}
          >
            {snap.delta.relative === null
              ? '—'
              : `${snap.delta.relative >= 0 ? '+' : ''}${(snap.delta.relative * 100).toFixed(1)}%`}
          </div>
          <div className="mt-1 text-xs text-ink-dim">
            {snap.delta.helping === true
              ? 'RAG helping (>=15% reduction)'
              : snap.delta.helping === false
                ? 'No improvement vs baseline'
                : baselineMissing
                  ? 'Capture baseline to compute delta'
                  : 'Not enough data'}
          </div>
        </div>
      </div>
    </Card>
  );
}
