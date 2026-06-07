'use client';

import { StepShell } from '../_components/StepShell';

// TODO(STAQPRO-152): wire to STAQPRO-131 admin password create + Caddy
// basic_auth provisioning. The wizard collects the password client-side,
// posts to a new /api/onboarding/admin route which bcrypt-hashes it,
// writes mailbox.onboarding.admin_password_hash, and triggers a Caddy
// config reload (.env update + container restart) so basic_auth picks it up.
export default function PasswordPage() {
  return (
    <StepShell slug="password">
      <h2 className="mb-2 text-sm font-semibold text-ink">What this step will do</h2>
      <ul className="list-disc space-y-1 pl-5 text-ink-muted">
        <li>
          Pick the username + password the appliance uses to gate the dashboard and n8n editor.
        </li>
        <li>The appliance bcrypt-hashes the password locally — Staqs never sees it.</li>
        <li>Caddy picks up the new credentials on the next config reload.</li>
      </ul>
    </StepShell>
  );
}
