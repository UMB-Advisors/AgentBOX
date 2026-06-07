// STAQPRO-331 #3 — operator-facing transparency about how this draft got
// its body: local Qwen3 vs cloud (gpt-oss / Haiku), the model id, the
// classifier confidence, and a short "why" tag when the route was a
// safety-net fallback rather than the normal category-based path. Pure
// derivation from existing columns (drafts.draft_source, drafts.model,
// inbox_messages.classification, inbox_messages.confidence) — see
// lib/classification/prompt.ts routingReasonFor.

import type { Category } from '@/lib/classification/prompt';
import { routingReasonFor } from '@/lib/classification/prompt';
import type { DraftSource } from '@/lib/types';

export function RoutingBadge({
  draftSource,
  model,
  classification,
  confidence,
}: {
  draftSource: DraftSource;
  model: string;
  classification: string | null;
  confidence: string | null;
}) {
  const conf = confidence != null ? Number.parseFloat(confidence) : null;
  const reason = routingReasonFor(draftSource, (classification as Category | null) ?? null, conf);

  const isCloud = draftSource === 'cloud' || draftSource === 'cloud_haiku';
  const palette = isCloud
    ? 'border-accent-blue/40 bg-accent-blue/10 text-accent-blue'
    : 'border-accent-green/40 bg-accent-green/10 text-accent-green';

  const routeLabel = isCloud ? 'Cloud' : 'Local';
  const reasonLabel = REASON_LABEL[reason];
  const reasonTone = reason === 'cloud_low_confidence' ? 'text-accent-orange' : 'text-ink-dim';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] ${palette}`}
      title={`${routeLabel} route · ${model}${conf != null ? ` · classifier confidence ${Math.round(conf * 100)}%` : ''} · ${reasonLabel}`}
    >
      <span className="font-semibold">{routeLabel}</span>
      <span className="text-ink-dim">·</span>
      <span className="text-ink-muted">{shortModel(model)}</span>
      {conf != null && (
        <>
          <span className="text-ink-dim">·</span>
          <span className="text-ink-muted">conf {Math.round(conf * 100)}%</span>
        </>
      )}
      {reason !== 'unknown' && reasonLabel && (
        <>
          <span className="text-ink-dim">·</span>
          <span className={reasonTone}>{reasonLabel}</span>
        </>
      )}
    </span>
  );
}

const REASON_LABEL: Record<ReturnType<typeof routingReasonFor>, string> = {
  local_category: 'category match',
  cloud_category: 'category match',
  cloud_low_confidence: 'low confidence fallback',
  unknown: '',
};

// Strip the registry / provider prefix to keep the badge compact.
// qwen3:4b-ctx4k → qwen3:4b-ctx4k (already short)
// gpt-oss:120b → gpt-oss:120b (already short)
// claude-haiku-4-5-20251001 → haiku-4-5
function shortModel(model: string): string {
  if (model.startsWith('claude-haiku-')) return 'haiku-4-5';
  if (model.startsWith('claude-sonnet-')) return 'sonnet-4-6';
  if (model.startsWith('claude-opus-')) return 'opus-4-7';
  return model;
}
