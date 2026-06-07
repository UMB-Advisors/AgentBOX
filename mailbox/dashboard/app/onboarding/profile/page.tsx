'use client';

import { StepShell } from '../_components/StepShell';

// TODO(STAQPRO-152): collect operator first name, brand, signoff seed
// values for mailbox.persona.statistical_markers. The persona resolver
// (STAQPRO-195) already reads these as the operator-override layer, so the
// wizard just needs a form that POSTs to /api/persona/settings.
export default function ProfilePage() {
  return (
    <StepShell slug="profile">
      <h2 className="mb-2 text-sm font-semibold text-ink">What this step will do</h2>
      <ul className="list-disc space-y-1 pl-5 text-ink-muted">
        <li>Collect operator first name and brand (used in draft greetings).</li>
        <li>Capture a default signoff string (e.g., "Thanks, Eric").</li>
        <li>Pre-populate the persona row so the very first draft already sounds like you.</li>
      </ul>
    </StepShell>
  );
}
