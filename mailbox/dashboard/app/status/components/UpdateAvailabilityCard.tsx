// MBOX-184 / MBOX-347 — read-only "Update available" card — extracted from page.tsx.
// Renders, per locally-built service (mailbox-dashboard + caddy), whether the
// running container's image digest matches the latest GHCR-published digest read
// live from the registry. Read-only by design.

import { shortDigest, type UpdateAvailability } from '@/lib/queries-update';
import { Card } from './Primitives';

export function UpdateAvailabilityCard({ updates }: { updates: UpdateAvailability }) {
  if (updates.reason) {
    return (
      <Card>
        <p className="text-sm text-ink-dim">update check unavailable: {updates.reason}</p>
      </Card>
    );
  }
  if (updates.services.length === 0) {
    return (
      <Card>
        <p className="text-sm text-ink-dim">no services to check</p>
      </Card>
    );
  }
  return (
    <Card>
      {updates.update_available ? (
        <p className="text-sm text-accent-orange">
          Update available — a newer image has been published to GHCR. Apply with{' '}
          <code className="font-mono">
            git pull &amp;&amp; docker compose up -d --remove-orphans
          </code>{' '}
          on the appliance (see root CLAUDE.md "Deploy flow").
        </p>
      ) : (
        <p className="text-sm text-accent-green">Up to date — no newer published images.</p>
      )}
      <ul className="mt-3 space-y-1 text-xs">
        {updates.services.map((s) => {
          const tone =
            s.state === 'update_available'
              ? 'text-accent-orange'
              : s.state === 'up_to_date'
                ? 'text-accent-green'
                : 'text-ink-dim';
          return (
            <li key={s.service} className="flex items-baseline justify-between gap-3 font-mono">
              <span className="text-ink-muted">{s.service}</span>
              <span className={`text-right ${tone}`}>
                {s.state === 'update_available'
                  ? `${shortDigest(s.running_digest)} → ${shortDigest(s.manifest_digest)}`
                  : s.state === 'up_to_date'
                    ? `up to date (${shortDigest(s.running_digest)})`
                    : s.state}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-ink-dim">
        Source-of-truth: latest GHCR-published digests read live from{' '}
        <code className="font-mono">ghcr.io</code> (cached ~60s) vs running container digests via
        the MBOX-168 read-only docker.sock reader. Read-only — apply updates from the shell.
        MBOX-184 / MBOX-347.
      </p>
    </Card>
  );
}
