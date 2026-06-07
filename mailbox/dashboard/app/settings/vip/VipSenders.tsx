'use client';

import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { SettingsTabs } from '@/components/SettingsTabs';
import { TimeAgo } from '@/components/TimeAgo';
import { Toast } from '@/components/Toast';
import { apiUrl } from '@/lib/api';
import type { VipSender } from '@/lib/queries-vip';
import type { VipSenderKind } from '@/lib/types';

// MBOX-134 — VIP sender list management UI. Add/remove email-or-domain entries
// (no regex). Matches the existing settings-page style (App Shell + bg-panel
// cards + Tailwind v4 @theme tokens). Backs urgency 'vip' signal.

type ToastMsg = { kind: 'success' | 'error'; text: string } | null;

export function VipSenders({
  initial,
  loadError,
}: {
  initial: VipSender[];
  loadError: string | null;
}) {
  const [senders, setSenders] = useState<VipSender[]>(initial);
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<VipSenderKind>('email');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [toast, setToast] = useState<ToastMsg>(null);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/vip-senders'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email_or_domain: trimmed, kind, note: note.trim() || undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          data?.error === 'validation_failed'
            ? (data.issues?.[0]?.message ?? 'Invalid entry')
            : (data?.error ?? `Add failed (${res.status})`);
        throw new Error(msg);
      }
      const added = data.sender as VipSender;
      // Upsert in place — replace any existing row with the same id, else
      // prepend (mirrors the server's idempotent upsert on (value, kind)).
      setSenders((prev) => [added, ...prev.filter((s) => s.id !== added.id)]);
      setValue('');
      setNote('');
      setToast({ kind: 'success', text: `Added ${added.email_or_domain}` });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Add failed' });
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(s: VipSender) {
    setDeletingId(s.id);
    try {
      const res = await fetch(apiUrl(`/api/vip-senders/${s.id}`), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Delete failed (${res.status})`);
      }
      setSenders((prev) => prev.filter((row) => row.id !== s.id));
      setToast({ kind: 'success', text: `Removed ${s.email_or_domain}` });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Delete failed' });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <AppShell active={{ kind: 'surface', surface: 'settings' }}>
      <SettingsTabs active="vip" />
      <header className="flex h-12 shrink-0 items-center border-b border-border-subtle bg-bg-panel px-4">
        <span className="font-mono text-[11px] text-ink-dim">VIP senders</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-4 lg:p-6">
          <section>
            <h2 className="mb-1 font-sans text-base font-semibold">VIP senders</h2>
            <p className="text-sm text-ink-muted">
              Email from a VIP sender is always flagged urgent in the queue — by exact address or by
              whole domain. No wildcards or patterns.
            </p>
          </section>

          {loadError && (
            <div className="rounded-sm border border-accent-red/40 bg-accent-red/10 p-3 text-xs text-accent-red">
              <p className="mb-1 font-medium">Failed to load VIP senders</p>
              <p className="font-mono">{loadError}</p>
            </div>
          )}

          {/* Add form */}
          <form
            onSubmit={onAdd}
            className="space-y-3 rounded-sm border border-border bg-bg-panel p-4"
          >
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">
                  Match by
                </span>
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as VipSenderKind)}
                  className="rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink"
                >
                  <option value="email">Email</option>
                  <option value="domain">Domain</option>
                </select>
              </label>
              <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
                <span className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">
                  {kind === 'email' ? 'Email address' : 'Domain'}
                </span>
                <input
                  type="text"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={kind === 'email' ? 'ceo@acme.com' : 'acme.com'}
                  className="rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-dim"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">
                Note (optional)
              </span>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="key account, escalations, …"
                className="rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-dim"
              />
            </label>
            <button
              type="submit"
              disabled={busy || value.trim().length === 0}
              className="inline-flex items-center gap-1.5 rounded-sm bg-accent-orange px-4 py-2 font-sans text-sm font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add VIP sender'}
            </button>
          </form>

          {/* List */}
          <section>
            <h3 className="mb-2 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Current list ({senders.length})
            </h3>
            {senders.length === 0 ? (
              <p className="rounded-sm border border-border-subtle bg-bg-panel p-3 text-sm text-ink-muted">
                No VIP senders yet. Add one above to start flagging their email as urgent.
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle rounded-sm border border-border-subtle bg-bg-panel">
                {senders.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-sm text-ink">
                          {s.email_or_domain}
                        </span>
                        <span className="rounded-sm border border-border-subtle px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                          {s.kind}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-ink-dim">
                        added <TimeAgo iso={s.added_at} />
                        {s.note ? ` · ${s.note}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onDelete(s)}
                      disabled={deletingId === s.id}
                      aria-label={`Remove ${s.email_or_domain}`}
                      className="inline-flex items-center gap-1 rounded-sm border border-border-subtle px-2 py-1 font-mono text-[11px] text-ink-muted transition-colors hover:border-accent-red/60 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trash2 size={12} />
                      {deletingId === s.id ? 'Removing…' : 'Remove'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {toast && <Toast {...toast} onDismiss={() => setToast(null)} />}
    </AppShell>
  );
}
