// Orphan containers section. Extracted from status/page.tsx.

import type { OrphanResult } from '@/lib/queries-orphans';
import { Card } from './Primitives';

interface OrphansSectionProps {
  orphans: OrphanResult;
}

export function OrphansSection({ orphans }: OrphansSectionProps) {
  return (
    <section className="mb-6">
      <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
        Orphan containers
      </h2>
      <Card>
        {orphans.status === 'red' && orphans.orphan_count === 0 ? (
          <p className="text-sm text-ink-dim">
            orphan check unavailable: {orphans.reason ?? 'unknown'}
          </p>
        ) : orphans.status === 'green' ? (
          <div>
            <p className="text-sm text-accent-green">
              No orphans — all {orphans.expected_names.length} running containers are declared in
              docker-compose.yml.
            </p>
            {orphans.expected_names.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-ink-dim">
                  expected ({orphans.expected_names.length})
                </summary>
                <ul className="mt-1 font-mono text-xs text-ink-dim">
                  {orphans.expected_names.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ) : (
          <div>
            <p className="text-sm text-accent-red">
              {orphans.orphan_count} orphan container
              {orphans.orphan_count === 1 ? '' : 's'} running outside docker-compose.yml — likely
              the "memory eaten by ghost process" failure class (DR-25 misdiagnosis). Investigate
              with <code className="font-mono">docker stop &lt;name&gt;</code>.
            </p>
            <ul className="mt-2 font-mono text-xs text-accent-red">
              {orphans.orphan_names.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            {orphans.expected_names.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-ink-dim">
                  expected ({orphans.expected_names.length})
                </summary>
                <ul className="mt-1 font-mono text-xs text-ink-dim">
                  {orphans.expected_names.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}
