// System stats grid — top-of-page health numbers. Extracted from status/page.tsx.

import type { checkMemoryPressure } from '@/lib/preflight/memory';
import type { checkSwap } from '@/lib/preflight/swap';
import type { ClassificationHealth } from '@/lib/queries-system';
import { Stat } from './Primitives';
import { formatBytes, formatRelative, formatUptime } from './utils';

interface SystemStatsSectionProps {
  uptimeSeconds: number;
  queueDepth: number | null;
  activeWorkflowCount: number | null;
  lastEmailReceivedAt: string | null;
  memory: ReturnType<typeof checkMemoryPressure>;
  swap: ReturnType<typeof checkSwap>;
  classificationHealth: ClassificationHealth | null;
  classifyTone: 'default' | 'green' | 'orange' | 'red';
  classifyLagSeconds: number | null;
}

export function SystemStatsSection({
  uptimeSeconds,
  queueDepth,
  activeWorkflowCount,
  lastEmailReceivedAt,
  memory,
  swap,
  classificationHealth,
  classifyTone,
}: SystemStatsSectionProps) {
  return (
    <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Stat label="Uptime" value={formatUptime(uptimeSeconds)} mono />
      <Stat
        label="Queue depth"
        value={queueDepth ?? '—'}
        tone={queueDepth !== null && queueDepth > 20 ? 'orange' : 'default'}
        sub="pending + awaiting_cloud"
      />
      <Stat
        label="n8n active workflows"
        value={activeWorkflowCount ?? '—'}
        sub="MailBOX + MailBOX-Send expected = 2"
        tone={activeWorkflowCount !== null && activeWorkflowCount < 2 ? 'red' : 'default'}
      />
      <Stat
        label="Last email"
        value={formatRelative(lastEmailReceivedAt)}
        sub={lastEmailReceivedAt ?? 'no emails yet'}
        mono
      />
      <Stat
        label="Memory pressure"
        value={
          memory.status === 'red' && memory.memAvailableGiB === 0
            ? '—'
            : `${memory.memAvailableGiB.toFixed(2)} GiB`
        }
        sub={
          memory.status === 'green'
            ? `MemAvailable > ${memory.minMemGiB.toFixed(2)} GiB threshold`
            : memory.status === 'amber'
              ? `within 200 MiB of ${memory.minMemGiB.toFixed(2)} GiB threshold`
              : memory.memAvailableGiB === 0
                ? 'unable to read /proc/meminfo'
                : `below ${memory.minMemGiB.toFixed(2)} GiB threshold`
        }
        tone={memory.status === 'red' ? 'red' : memory.status === 'amber' ? 'orange' : 'default'}
        mono
      />
      {/* MBOX-168 — swap-in-use companion to memory_pressure. Green when
          zero, yellow inside the threshold (zram noise floor), red when
          we're actually paging RAM out. */}
      <Stat
        label="Swap in use"
        value={
          swap.status === 'red' && swap.swap_total_bytes === 0
            ? '—'
            : formatBytes(swap.swap_in_use_bytes)
        }
        sub={
          swap.status === 'green'
            ? swap.swap_total_bytes === 0
              ? 'no swap configured'
              : `0 of ${formatBytes(swap.swap_total_bytes)} configured`
            : swap.status === 'red' && swap.swap_total_bytes === 0
              ? 'unable to read /proc/meminfo'
              : `threshold ${swap.threshold_mib} MiB — RAM over-committed if exceeded`
        }
        tone={swap.status === 'red' ? 'red' : swap.status === 'yellow' ? 'orange' : 'default'}
        mono
      />
      <Stat
        label="Classify lag"
        value={
          classificationHealth === null
            ? '—'
            : classificationHealth.unclassifiedCount24h === 0
              ? 'caught up'
              : formatRelative(classificationHealth.unclassifiedSince)
        }
        sub={
          classificationHealth === null
            ? 'unavailable'
            : classificationHealth.unclassifiedCount24h === 0
              ? `last: ${formatRelative(classificationHealth.lastClassifiedAt)}`
              : `${classificationHealth.unclassifiedCount24h} unclassified (24h)`
        }
        tone={classifyTone}
        mono
      />
    </section>
  );
}
