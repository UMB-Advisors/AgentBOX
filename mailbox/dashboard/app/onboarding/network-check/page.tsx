'use client';

import { StepShell } from '../_components/StepShell';

// TODO(STAQPRO-152): live Caddy/Cloudflare cert health probe + LAN
// reachability widget. Server route should hit caddy:2019/config + the
// public hostname's HTTPS endpoint, and return a structured pass/fail with
// remediation hints (DNS not propagated, ACME challenge failed, etc).
export default function NetworkCheckPage() {
  return (
    <StepShell slug="network-check">
      <h2 className="mb-2 text-sm font-semibold text-ink">What this step will do</h2>
      <ul className="list-disc space-y-1 pl-5 text-ink-muted">
        <li>Verify the appliance can reach Gmail's API endpoints (oauth + send).</li>
        <li>Confirm the public dashboard hostname resolves and the HTTPS cert is valid.</li>
        <li>
          Check the cloud drafter (Ollama Cloud / Anthropic) is reachable for the safety-net path.
        </li>
      </ul>
    </StepShell>
  );
}
