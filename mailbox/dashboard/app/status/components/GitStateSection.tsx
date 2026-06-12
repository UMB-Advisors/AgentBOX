// Appliance git state section. Extracted from status/page.tsx.

import { OtaUpdateButton } from '@/components/OtaUpdateButton';
import type { GitState } from '@/lib/queries-git';
import { Card, Stat } from './Primitives';
import { formatAgeSeconds } from './utils';

interface GitStateSectionProps {
  gitState: GitState;
  gitTone: 'default' | 'green' | 'orange' | 'red';
}

export function GitStateSection({ gitState, gitTone }: GitStateSectionProps) {
  return (
    <section className="mb-6">
      <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
        Appliance git state
      </h2>
      {!gitState.available ? (
        <Card>
          <p className="text-sm text-ink-dim">
            git state unavailable: {gitState.reason ?? 'unknown'}
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat
            label="Branch"
            value={gitState.git_branch ?? '—'}
            sub={gitState.git_short_sha ?? ''}
            tone={gitTone}
            mono
          />
          <Stat
            label="Behind master"
            value={gitState.commits_behind_master ?? '—'}
            sub={
              gitState.commits_behind_master === null
                ? 'no origin/master ref'
                : gitState.commits_behind_master === 0
                  ? 'up to date'
                  : "origin has commits we don't"
            }
            tone={
              gitState.commits_behind_master !== null && gitState.commits_behind_master > 0
                ? 'red'
                : 'default'
            }
            mono
          />
          <Stat
            label="Ahead master"
            value={gitState.commits_ahead_master ?? '—'}
            sub={
              gitState.commits_ahead_master !== null && gitState.commits_ahead_master > 0
                ? 'local-only commits'
                : 'in sync'
            }
            mono
          />
          <Stat
            label="Last fetch"
            value={
              gitState.fetch_age_seconds === null
                ? 'never'
                : formatAgeSeconds(gitState.fetch_age_seconds)
            }
            sub={
              gitState.fetch_age_seconds === null
                ? 'no FETCH_HEAD'
                : gitState.fetch_age_seconds > 3600
                  ? 'stale (>1h) — `git fetch` to refresh'
                  : 'fresh'
            }
            tone={
              gitState.fetch_age_seconds === null || gitState.fetch_age_seconds > 3600
                ? 'orange'
                : 'default'
            }
            mono
          />
          <Stat
            label="Working tree"
            value={gitState.dirty ? 'dirty' : 'clean'}
            sub={gitState.dirty ? 'uncommitted changes on appliance' : ''}
            tone={gitState.dirty ? 'orange' : 'default'}
            mono
          />
        </div>
      )}
      {/* MBOX-349 — customer-initiated OTA "Update now" execute path. */}
      <div className="mt-3 border-t border-border-subtle pt-3">
        <div className="mb-2 text-xs uppercase tracking-wider text-ink-dim">OTA update</div>
        <OtaUpdateButton />
      </div>
    </section>
  );
}
