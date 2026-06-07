'use client';

import { useState } from 'react';
import { StepShell } from '../_components/StepShell';
import { ImapConnectForm } from './ImapConnectForm';

// MBOX-357 (P1 T6) — provider picker for the email-connect step. Gmail stays
// the existing OAuth stub (STAQPRO-152/197 — the real OAuth + n8n credential
// handoff is unbuilt); IMAP/SMTP is the first real connect flow and persists a
// validated account via /api/internal/onboarding/imap-connect. After connecting,
// the wizard's existing Next button advances to the final step.
type Provider = 'gmail' | 'imap';

const tabBase = 'flex-1 rounded-lg border px-4 py-2 text-sm font-medium transition-colors';
const tabOn = 'border-accent-orange bg-accent-orange/10 text-ink';
const tabOff = 'border-border text-ink-muted hover:bg-bg-panel';

export default function EmailConnectPage() {
  const [provider, setProvider] = useState<Provider>('gmail');

  return (
    <StepShell slug="email-connect">
      <div className="mb-4 flex gap-2">
        <button
          type="button"
          onClick={() => setProvider('gmail')}
          className={`${tabBase} ${provider === 'gmail' ? tabOn : tabOff}`}
        >
          Gmail
        </button>
        <button
          type="button"
          onClick={() => setProvider('imap')}
          className={`${tabBase} ${provider === 'imap' ? tabOn : tabOff}`}
        >
          IMAP / SMTP
        </button>
      </div>

      {provider === 'gmail' ? (
        <>
          {/* TODO(STAQPRO-152): real Gmail OAuth flow + n8n credential handoff
              (architectural — needs spec). Per-customer OAuth client today
              (STAQPRO-197 tracks the shared-client move). The flow must end with
              a refresh token written into n8n's credentials_entity table under
              the credential id n8n's workflows reference. */}
          <h2 className="mb-2 text-sm font-semibold text-ink">What this step will do</h2>
          <ul className="list-disc space-y-1 pl-5 text-ink-muted">
            <li>
              Open a Gmail consent screen so the appliance can read inbox + send replies on your
              behalf.
            </li>
            <li>Hand the resulting refresh token to n8n's encrypted credential store.</li>
            <li>
              Kick off the first 90-day backfill so the persona extractor has a corpus to learn
              from.
            </li>
          </ul>
        </>
      ) : (
        <ImapConnectForm />
      )}
    </StepShell>
  );
}
