// Last inference + Disk section. Extracted from status/page.tsx.

import type { getDiskFree, getLastInferenceLatency } from '@/lib/queries-system';
import { Card } from './Primitives';
import { formatBytes, formatRelative } from './utils';

interface InferenceAndDiskSectionProps {
  lastInference: Awaited<ReturnType<typeof getLastInferenceLatency>>;
  diskFree: Awaited<ReturnType<typeof getDiskFree>>;
}

export function InferenceAndDiskSection({ lastInference, diskFree }: InferenceAndDiskSectionProps) {
  return (
    <section className="mb-6 grid gap-3 lg:grid-cols-2">
      <Card title="Last inference">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl font-semibold tracking-tight">
            {lastInference.latency_ms !== null ? `${lastInference.latency_ms}ms` : '—'}
          </span>
          {lastInference.at && (
            <span className="text-xs text-ink-dim">{formatRelative(lastInference.at)}</span>
          )}
        </div>
        <p className="mt-1 text-xs text-ink-dim">
          SLA: &lt;30s local / &lt;60s cloud per project Constraints
        </p>
      </Card>
      <Card title="Disk">
        {diskFree ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-2xl font-semibold tracking-tight">
                {formatBytes(diskFree.free_bytes)}
              </span>
              <span className="text-sm text-ink-muted">
                free of {formatBytes(diskFree.total_bytes)}
              </span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-sm bg-bg-deep">
              <div
                className="h-full bg-accent-blue"
                style={{
                  width: `${Math.round(
                    ((diskFree.total_bytes - diskFree.free_bytes) / diskFree.total_bytes) * 100,
                  )}%`,
                }}
              />
            </div>
          </>
        ) : (
          <span className="text-ink-dim">unavailable</span>
        )}
      </Card>
    </section>
  );
}
