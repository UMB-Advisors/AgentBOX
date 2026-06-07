'use client';

import { useState } from 'react';
import { apiUrl } from '@/lib/api';

// MBOX-358 (P2) — Microsoft 365 / Graph connect form. Mirrors ImapConnectForm:
// "Test connection" and "Save & connect" hit the same endpoint (mode test|save)
// so the save runs the identical app-only token + inbox probe; bad credentials
// never persist. Reused in two places:
//   onboarding wizard → endpoint /api/internal/onboarding/graph-connect,
//     showNextPrompt (the wizard's Next button advances the stage).
//   settings Inboxes → endpoint /api/accounts/microsoft, onSaved() to refresh
//     the account list. NO wizard nav.
//
// v1 = BYO Azure app registration (app-only / client-credentials, NC-34): the
// operator registers an app in their tenant, grants it the Mail.ReadWrite
// APPLICATION permission + admin consent, and pastes tenant/client id + secret.

interface LegResult {
  ok: boolean;
  detail: string;
}
interface ProbeResponse {
  ok: boolean;
  token?: LegResult;
  mailbox?: LegResult;
  account_id?: number;
  error?: string;
}

interface GraphConnectFormProps {
  // Defaults to the onboarding route so wizard usage is unchanged.
  endpoint?: string;
  // true → "click Next to finish" (wizard). false → "Mailbox added" (settings).
  showNextPrompt?: boolean;
  // Called after a successful save (settings → refresh the account list).
  onSaved?: (accountId: number | undefined) => void;
}

const inputCls =
  'w-full rounded-lg border border-border bg-bg-panel px-3 py-2 text-sm text-ink placeholder:text-ink-muted/60 focus:border-accent-orange focus:outline-none';
const labelCls = 'block text-xs font-medium text-ink-muted';

export function GraphConnectForm({
  endpoint = '/api/internal/onboarding/graph-connect',
  showNextPrompt = true,
  onSaved,
}: GraphConnectFormProps = {}) {
  const [email, setEmail] = useState('');
  const [displayLabel, setDisplayLabel] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [mailbox, setMailbox] = useState('');

  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [result, setResult] = useState<ProbeResponse | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(mode: 'test' | 'save') {
    setBusy(mode);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(apiUrl(endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode,
          email,
          display_label: displayLabel || undefined,
          tenant_id: tenantId,
          client_id: clientId,
          client_secret: clientSecret,
          mailbox: mailbox || undefined,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as ProbeResponse & { error?: string };
      if (res.status === 400) {
        setError('Please fill every field with a valid value.');
        return;
      }
      setResult(payload);
      if (res.ok && payload.ok && mode === 'save') {
        setSaved(true);
        onSaved?.(payload.account_id);
      }
      if (!res.ok && payload.error) setError(payload.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-ink-muted">
        Connect an Outlook / Microsoft 365 mailbox. Register an app in your{' '}
        <span className="font-medium text-ink">Azure portal</span>, grant it the{' '}
        <span className="font-medium text-ink">Mail.ReadWrite</span> application permission with
        admin consent, then paste the tenant id, client id, and a client secret value below.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="graph-email">
            Email address
          </label>
          <input
            id="graph-email"
            type="email"
            className={inputCls}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@yourcompany.com"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="graph-tenant">
            Directory (tenant) ID
          </label>
          <input
            id="graph-tenant"
            className={inputCls}
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="graph-client">
            Application (client) ID
          </label>
          <input
            id="graph-client"
            className={inputCls}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="graph-secret">
            Client secret value
          </label>
          <input
            id="graph-secret"
            type="password"
            className={inputCls}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="off"
            placeholder="the secret VALUE, not its id"
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="graph-mailbox">
            Mailbox UPN (optional — defaults to the email above)
          </label>
          <input
            id="graph-mailbox"
            className={inputCls}
            value={mailbox}
            onChange={(e) => setMailbox(e.target.value)}
            placeholder="shared-inbox@yourcompany.com"
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="graph-label">
            Label (optional)
          </label>
          <input
            id="graph-label"
            className={inputCls}
            value={displayLabel}
            onChange={(e) => setDisplayLabel(e.target.value)}
            placeholder="e.g. Support inbox"
          />
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-accent-red/40 bg-accent-red/10 px-4 py-2 text-sm text-accent-red"
        >
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="space-y-1 rounded-lg border border-border bg-bg-panel px-4 py-3 text-sm">
          <LegRow label="App token" leg={result.token} />
          <LegRow label="Inbox read" leg={result.mailbox} />
          {saved ? (
            <p className="pt-1 font-medium text-accent-green">
              {showNextPrompt ? (
                <>
                  Mailbox connected. Click <span className="font-semibold">Next</span> to finish
                  setup.
                </>
              ) : (
                <>Mailbox added.</>
              )}
            </p>
          ) : result.ok && !saved ? (
            <p className="pt-1 text-ink-muted">
              Both checks passed — click{' '}
              <span className="font-medium text-ink">Save &amp; connect</span>.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => submit('test')}
          disabled={busy !== null}
          className="rounded-lg border border-border px-4 py-2 text-sm text-ink hover:bg-bg-panel disabled:opacity-50"
        >
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          onClick={() => submit('save')}
          disabled={busy !== null}
          className="rounded-lg bg-accent-orange px-5 py-2 text-sm font-semibold text-white hover:bg-accent-orange/90 disabled:opacity-50"
        >
          {busy === 'save' ? 'Connecting…' : 'Save & connect'}
        </button>
      </div>
    </div>
  );
}

function LegRow({ label, leg }: { label: string; leg?: LegResult }) {
  if (!leg) return null;
  return (
    <p className={leg.ok ? 'text-accent-green' : 'text-accent-red'}>
      <span className="font-medium">
        {leg.ok ? '✓' : '✗'} {label}:
      </span>{' '}
      <span className="text-ink-muted">{leg.detail}</span>
    </p>
  );
}
