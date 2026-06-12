// Qdrant + Ollama sections. Extracted from status/page.tsx.

import type { getOllamaLoadedModels, QdrantCollectionHealth } from '@/lib/queries-system';
import { Card } from './Primitives';
import { formatBytes } from './utils';

interface QdrantAndOllamaSectionProps {
  qdrantCollection: QdrantCollectionHealth | null;
  ollamaModels: Awaited<ReturnType<typeof getOllamaLoadedModels>>;
}

export function QdrantAndOllamaSection({
  qdrantCollection,
  ollamaModels,
}: QdrantAndOllamaSectionProps) {
  return (
    <>
      <section className="mb-6">
        <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
          Qdrant — RAG corpus (M3.5)
        </h2>
        <Card>
          {qdrantCollection === null ? (
            <p className="text-sm text-accent-red">
              Qdrant unreachable at{' '}
              <code className="font-mono">{process.env.QDRANT_URL ?? 'http://qdrant:6333'}</code> —
              RAG retrieval disabled; drafts will use persona only. STAQPRO-188.
            </p>
          ) : !qdrantCollection.exists ? (
            <p className="text-sm text-accent-orange">
              Collection <code className="font-mono">email_messages</code> missing — run{' '}
              <code className="font-mono">
                docker compose --profile qdrant-bootstrap up mailbox-qdrant-bootstrap
              </code>
              .
            </p>
          ) : (
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-2xl font-semibold tracking-tight">
                {qdrantCollection.points_count ?? 0}
              </span>
              <span className="text-sm text-ink-muted">points in email_messages</span>
            </div>
          )}
        </Card>
      </section>

      <section className="mb-6">
        <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
          Ollama loaded models
        </h2>
        <Card>
          {ollamaModels === null ? (
            <p className="text-sm text-accent-red">
              Ollama unreachable at{' '}
              <code className="font-mono">
                {process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434'}
              </code>{' '}
              — local drafting path is degraded; cloud route still works.
            </p>
          ) : ollamaModels.length === 0 ? (
            <p className="text-sm text-ink-dim">
              No models in memory. First request will load on demand.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {ollamaModels.map((m) => (
                <li key={m.name} className="flex items-center justify-between">
                  <span className="font-mono">{m.name}</span>
                  {m.size_vram !== undefined && (
                    <span className="text-xs text-ink-dim">{formatBytes(m.size_vram)} VRAM</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </>
  );
}
