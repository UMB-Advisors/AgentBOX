'use client';

import { apiUrl } from '@/lib/api';
import { StepShell } from '../_components/StepShell';

// TODO(STAQPRO-152): show first-poll ETA + link to /dashboard/queue +
// send "you're live" email. The 5-minute Schedule trigger means the first
// draft can take up to 5 minutes to appear; the page should show a small
// countdown sourced from the parent workflow's `nextRunAt` (read via the
// n8n REST API or a /api/system/status helper).
//
// STAQPRO-235 — once the operator has been live for a while and the
// telemetry view (v_override_rate from STAQPRO-233) has signal, point them
// at the metric-driven KB nudge UI. The link is appended to this page
// rather than added as an onboarding stage so the six-stage state machine
// (per Neo Architect: stays as six stages) is unchanged. The /settings/kb
// page itself handles the "not enough drafts yet" case.
export default function CompletePage() {
  return (
    <StepShell slug="complete">
      <h2 className="mb-2 text-sm font-semibold text-ink">What this step will do</h2>
      <ul className="list-disc space-y-1 pl-5 text-ink-muted">
        <li>Confirm the appliance is now polling Gmail every 5 minutes.</li>
        <li>Send a one-time "you're live" email so the operator knows the send path works.</li>
        <li>Hand off to the queue, where the very first draft will land in under 5 minutes.</li>
      </ul>

      <div className="mt-6 border-t border-border pt-4">
        <h3 className="mb-2 text-sm font-semibold text-ink">Next: improve your drafts</h3>
        <p className="mb-3 text-sm text-ink-muted">
          After your first 20 drafts, head to{' '}
          <span className="font-mono text-ink">Settings → Knowledge Base</span> to drop in SOPs for
          the categories where you're rewriting the most.
        </p>
        <a
          href={apiUrl('/settings/kb')}
          className="inline-block rounded-sm border border-border px-3 py-1 font-mono text-xs text-ink-muted hover:border-border hover:text-ink"
        >
          Improve your drafts →
        </a>
      </div>
    </StepShell>
  );
}
