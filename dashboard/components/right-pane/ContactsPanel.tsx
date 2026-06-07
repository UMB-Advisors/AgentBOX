'use client';

import { Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { apiUrl } from '@/lib/api';
import { CenteredNotice, ConnectNotice, reasonNotice } from './panel-chrome';

// MBOX-398 — Contacts panel. Reads /api/contacts (Google People API via the
// google_contacts grant), client-side search + an openable contact card.

interface Contact {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  photoUrl: string | null;
}
interface ContactsResult {
  reason: string;
  contacts: Contact[];
}

export function ContactsPanel() {
  const [result, setResult] = useState<ContactsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/contacts'));
        const data = (await res.json().catch(() => null)) as ContactsResult | null;
        if (alive) setResult(data ?? { reason: 'fetch_failed', contacts: [] });
      } catch {
        if (alive) setResult({ reason: 'fetch_failed', contacts: [] });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!result) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return result.contacts;
    return result.contacts.filter(
      (c) =>
        c.name.toLowerCase().includes(needle) ||
        c.emails.some((e) => e.toLowerCase().includes(needle)),
    );
  }, [result, q]);

  if (loading && !result) return <CenteredNotice title="Loading…" />;
  if (!result || result.reason === 'not_connected') {
    return (
      <ConnectNotice
        icon={<Users className="h-8 w-8 text-ink-dim" aria-hidden />}
        label="Contacts"
      />
    );
  }
  if (result.reason !== 'ok') return reasonNotice(result.reason);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border-subtle p-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search contacts"
          className="w-full rounded-sm border border-border bg-bg-panel px-2 py-1 font-sans text-xs text-ink placeholder:text-ink-dim focus:border-accent-blue focus:outline-none"
        />
      </div>
      {filtered.length === 0 ? (
        <CenteredNotice title={q ? 'No matches' : 'No contacts'} />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {filtered.map((c) => (
            <li key={c.id || c.name}>
              <button
                type="button"
                onClick={() => setOpenId((id) => (id === c.id ? null : c.id))}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-bg-panel"
              >
                <Avatar name={c.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-ink">{c.name}</span>
                  {c.emails[0] && (
                    <span className="block truncate font-mono text-[10px] text-ink-dim">
                      {c.emails[0]}
                    </span>
                  )}
                </span>
              </button>
              {openId === c.id && <ContactDetail c={c} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-panel font-mono text-[11px] text-ink-muted">
      {initial}
    </span>
  );
}

function ContactDetail({ c }: { c: Contact }) {
  return (
    <div className="space-y-1 border-b border-border-subtle bg-bg-panel/50 px-3 py-2 font-mono text-[11px]">
      {c.emails.map((e) => (
        <a key={e} href={`mailto:${e}`} className="block truncate text-accent-blue hover:underline">
          {e}
        </a>
      ))}
      {c.phones.map((p) => (
        <a key={p} href={`tel:${p}`} className="block text-ink-muted hover:text-ink">
          {p}
        </a>
      ))}
      {c.emails.length === 0 && c.phones.length === 0 && (
        <span className="text-ink-dim">No contact details.</span>
      )}
    </div>
  );
}
