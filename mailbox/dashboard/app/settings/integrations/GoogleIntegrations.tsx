'use client';

import { Calendar, CheckSquare, Link2, Unlink, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { SettingsTabs } from '@/components/SettingsTabs';
import { TimeAgo } from '@/components/TimeAgo';
import { Toast } from '@/components/Toast';
import { apiUrl } from '@/lib/api';
import type { OAuthConnection, OAuthProvider } from '@/lib/oauth/google';

// MBOX-130 + MBOX-129 — Google integrations connect/disconnect UI. One card per
// provider: Calendar (read-only pre-read, MBOX-130) and Tasks (action-item
// handoff, MBOX-129). Connect navigates to the connect-initiate route (302 to
// Google consent); disconnect revokes + clears the stored token. Matches the
// VIP settings style (App Shell + bg-panel cards + Tailwind v4 @theme tokens).

type ToastMsg = { kind: 'success' | 'error'; text: string } | null;

// MBOX-415 — account options for the per-account connect selector.
interface AccountOpt {
  id: number;
  email_address: string;
  display_label: string | null;
  is_default: boolean;
}

const META: Record<
  Extract<OAuthProvider, 'google_calendar' | 'google_tasks' | 'google_contacts'>,
  { title: string; blurb: string; Icon: typeof Calendar }
> = {
  google_calendar: {
    title: 'Google Calendar',
    blurb:
      'Read-only. Scheduling drafts pre-read your calendar so the box can propose concrete open times instead of "let me check my calendar." Also powers the Calendar panel in the right-side rail.',
    Icon: Calendar,
  },
  google_tasks: {
    title: 'Google Tasks',
    blurb:
      'Push extracted action items to your Google Tasks list with one click, and view your tasks in the right-side rail.',
    Icon: CheckSquare,
  },
  google_contacts: {
    title: 'Google Contacts',
    blurb:
      'Read-only. Powers the Contacts panel in the right-side rail so you can look up a counterparty without leaving the queue.',
    Icon: Users,
  },
};

function fallback(provider: OAuthProvider): OAuthConnection {
  return {
    provider,
    connected: false,
    scope: null,
    account_email: null,
    last_fetched_at: null,
    connected_at: null,
  };
}

export function GoogleIntegrations({
  calendar,
  tasks,
  contacts,
  loadError,
}: {
  calendar: OAuthConnection | null;
  tasks: OAuthConnection | null;
  contacts: OAuthConnection | null;
  loadError: string | null;
}) {
  const [conns, setConns] = useState<Record<string, OAuthConnection>>({
    google_calendar: calendar ?? fallback('google_calendar'),
    google_tasks: tasks ?? fallback('google_tasks'),
    google_contacts: contacts ?? fallback('google_contacts'),
  });
  const [busy, setBusy] = useState<OAuthProvider | null>(null);
  const [toast, setToast] = useState<ToastMsg>(null);
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);

  // MBOX-415 — populate the account selector; default to the default account
  // (whose connections arrived as initial props).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/accounts'));
        const data = (await res.json().catch(() => null)) as { accounts?: AccountOpt[] } | null;
        const list = data?.accounts ?? [];
        if (!alive) return;
        setAccounts(list);
        const def = list.find((a) => a.is_default) ?? list[0];
        if (def) setAccountId(def.id);
      } catch {
        /* selector stays hidden on failure */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Refetch each provider's connection status when the selected account changes.
  useEffect(() => {
    if (accountId == null) return;
    let alive = true;
    (async () => {
      const providerKeys: OAuthProvider[] = ['google_calendar', 'google_tasks', 'google_contacts'];
      const entries = await Promise.all(
        providerKeys.map(async (provider) => {
          try {
            const res = await fetch(
              apiUrl(`/api/oauth/google/${provider}?account_id=${accountId}`),
            );
            const data = (await res.json().catch(() => null)) as OAuthConnection | null;
            return [provider, data ?? fallback(provider)] as const;
          } catch {
            return [provider, fallback(provider)] as const;
          }
        }),
      );
      if (alive) setConns(Object.fromEntries(entries));
    })();
    return () => {
      alive = false;
    };
  }, [accountId]);

  function connect(provider: OAuthProvider) {
    // Full-page navigation to the connect initiator, which 302s to Google.
    const q = accountId != null ? `?account_id=${accountId}` : '';
    window.location.href = apiUrl(`/api/oauth/google/${provider}/connect${q}`);
  }

  async function disconnect(provider: OAuthProvider) {
    setBusy(provider);
    try {
      const q = accountId != null ? `?account_id=${accountId}` : '';
      const res = await fetch(apiUrl(`/api/oauth/google/${provider}${q}`), { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Disconnect failed (${res.status})`);
      setConns((prev) => ({ ...prev, [provider]: fallback(provider) }));
      setToast({
        kind: 'success',
        text: `Disconnected ${META[provider as keyof typeof META].title}`,
      });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Disconnect failed' });
    } finally {
      setBusy(null);
    }
  }

  const providers: Array<keyof typeof META> = [
    'google_calendar',
    'google_tasks',
    'google_contacts',
  ];

  return (
    <AppShell active={{ kind: 'surface', surface: 'settings' }}>
      <SettingsTabs active="integrations" />
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
        <header>
          <h1 className="font-mono text-lg uppercase tracking-wider text-ink">Integrations</h1>
          <p className="mt-1 font-sans text-sm text-ink-dim">
            Connect your Google account so the box can read your calendar and push tasks. Each
            integration uses its own scope and token — connecting one does not grant the other.
          </p>
        </header>

        {accounts.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-wide text-ink-dim">
              Account
            </span>
            <select
              value={accountId ?? ''}
              onChange={(e) => setAccountId(Number(e.target.value))}
              className="rounded-sm border border-border bg-bg-panel px-2 py-1 font-mono text-xs text-ink"
              aria-label="Account to connect"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_label || a.email_address}
                </option>
              ))}
            </select>
          </div>
        )}

        {loadError && (
          <p className="font-sans text-sm text-accent-red">
            Couldn’t load integration status: <span className="font-mono">{loadError}</span>
          </p>
        )}

        {providers.map((provider) => {
          const conn = conns[provider];
          const { title, blurb, Icon } = META[provider];
          return (
            <section key={provider} className="rounded-sm border border-border bg-bg-panel p-4">
              <div className="flex items-start gap-3">
                <Icon size={18} className="mt-0.5 shrink-0 text-ink-dim" aria-hidden />
                <div className="min-w-0 flex-1">
                  <h2 className="font-mono text-sm uppercase tracking-wide text-ink">{title}</h2>
                  <p className="mt-1 font-sans text-sm text-ink-dim">{blurb}</p>

                  {conn.connected ? (
                    <dl className="mt-3 flex flex-col gap-1 font-mono text-xs text-ink-muted">
                      <div className="flex gap-2">
                        <dt className="text-ink-dim">Account</dt>
                        <dd className="text-ink">{conn.account_email ?? '(unknown)'}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-ink-dim">Last fetched</dt>
                        <dd className="text-ink">
                          <TimeAgo iso={conn.last_fetched_at} />
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="mt-3 font-mono text-xs uppercase tracking-wide text-ink-dim">
                      Not connected
                    </p>
                  )}
                </div>

                <div className="shrink-0">
                  {conn.connected ? (
                    <button
                      type="button"
                      onClick={() => disconnect(provider)}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-sm border border-accent-red/40 px-2 py-1 font-sans text-xs text-accent-red transition-colors hover:bg-accent-red/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Unlink size={13} /> {busy === provider ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => connect(provider)}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-sm border border-accent-blue/40 px-2 py-1 font-sans text-xs text-accent-blue transition-colors hover:bg-accent-blue/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Link2 size={13} /> Connect
                    </button>
                  )}
                </div>
              </div>
            </section>
          );
        })}
      </div>

      {toast && <Toast kind={toast.kind} text={toast.text} onDismiss={() => setToast(null)} />}
    </AppShell>
  );
}
