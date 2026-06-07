'use client';

import { StepShell } from '../_components/StepShell';

// TODO(STAQPRO-152): brand intro + appliance overview — replace placeholder
// bullets with real welcome copy + a short "what to expect" panel once
// product copy is finalized for customer #2.
export default function WelcomePage() {
  return (
    <StepShell slug="welcome">
      <h2 className="mb-2 text-sm font-semibold text-ink">What this step will do</h2>
      <ul className="list-disc space-y-1 pl-5 text-ink-muted">
        <li>Introduce the appliance and what onboarding covers (about 10 minutes).</li>
        <li>Confirm the box is online and the dashboard is reachable from this device.</li>
        <li>
          Set expectations: the operator stays in the loop on every send during the first week.
        </li>
      </ul>
    </StepShell>
  );
}
