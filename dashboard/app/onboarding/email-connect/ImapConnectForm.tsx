'use client';

import { useState } from 'react';
import { apiUrl } from '@/lib/api';

// MBOX-357 (P1 T6 / FR-MP-6) — IMAP/SMTP connect form. "Test connection" and
// "Save & connect" hit the same endpoint (mode test|save) so the save runs the
// identical raw-socket probe; bad credentials never persist. Reused in two
// places (MBOX-357 settings "Add mailbox"):
//   onboarding wizard → endpoint /api/internal/onboarding/imap-connect,
//     showNextPrompt (the wizard's Next button advances the stage).
//   settings Mailboxes → endpoint /api/accounts/imap, onSaved() to refresh the
//     account list. NO wizard nav.

interface LegResult {
  ok: boolean;
  detail: string;
}
interface ProbeResponse {
  ok: boolean;
  imap?: LegResult;
  smtp?: LegResult;
  account_id?: number;
  error?: string;
}

interface ImapConnectFormProps {
  // Defaults to the onboarding route so existing wizard usage is unchanged.
  endpoint?: string;
  // true → "click Next to finish" (wizard). false → "Mailbox added" (settings).
  showNextPrompt?: boolean;
  // Called after a successful save (settings → refresh the account list).
  onSaved?: (accountId: number | undefined) => void;
}

const inputCls =
  'w-full rounded-lg border border-border bg-bg-panel px-3 py-2 text-sm text-ink placeholder:text-ink-muted/60 focus:border-accent-orange focus:outline-none';
const labelCls = 'block text-xs font-medium text-ink-muted';

export function ImapConnectForm({
  endpoint = '/api/internal/onboarding/imap-connect',
  showNextPrompt = true,
  onSaved,
}: ImapConnectFormProps = {}) {
  const [email, setEmail] = useState('');
  const [displayLabel, setDisplayLabel] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('993');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [username, setUsername] = useState('');
  const [appPassword, setAppPassword] = useState('');

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
          imap_host: imapHost,
          imap_port: imapPort,
          smtp_host: smtpHost,
          smtp_port: smtpPort,
          username: username || email,
          app_password: appPassword,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as ProbeResponse & {
        error?: string;
      };
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
        Connect a custom-domain mailbox over IMAP/SMTP (cPanel, Fastmail, Zoho, …). Use an{' '}
        <span className="font-medium text-ink">app password</span>, not your login password.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="imap-email">
            Email address
          </label>
          <input
            id="imap-email"
            type="email"
            className={inputCls}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@yourdomain.com"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="imap-host">
            IMAP host
          </label>
          <input
            id="imap-host"
            className={inputCls}
            value={imapHost}
            onChange={(e) => setImapHost(e.target.value)}
            placeholder="imap.yourdomain.com"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="imap-port">
            IMAP port (TLS)
          </label>
          <input
            id="imap-port"
            inputMode="numeric"
            className={inputCls}
            value={imapPort}
            onChange={(e) => setImapPort(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="smtp-host">
            SMTP host
          </label>
          <input
            id="smtp-host"
            className={inputCls}
            value={smtpHost}
            onChange={(e) => setSmtpHost(e.target.value)}
            placeholder="smtp.yourdomain.com"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="smtp-port">
            SMTP port (465 TLS / 587 STARTTLS)
          </label>
          <input
            id="smtp-port"
            inputMode="numeric"
            className={inputCls}
            value={smtpPort}
            onChange={(e) => setSmtpPort(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="imap-username">
            Username
          </label>
          <input
            id="imap-username"
            className={inputCls}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="usually your full email"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="imap-password">
            App password
          </label>
          <input
            id="imap-password"
            type="password"
            className={inputCls}
            value={appPassword}
            onChange={(e) => setAppPassword(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="imap-label">
            Label (optional)
          </label>
          <input
            id="imap-label"
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
          <LegRow label="IMAP (read)" leg={result.imap} />
          <LegRow label="SMTP (send)" leg={result.smtp} />
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
