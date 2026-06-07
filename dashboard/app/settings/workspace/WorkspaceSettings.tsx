'use client';

import { Calendar, FolderOpen, LinkIcon } from 'lucide-react';
import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { SettingsTabs } from '@/components/SettingsTabs';
import { Toast } from '@/components/Toast';
import { apiUrl } from '@/lib/api';
import { buildCalendarEmbedUrl, buildDriveEmbedUrl } from '@/lib/embed';
import type { OperatorSettings } from '@/lib/types';

// MBOX-162 P4 — operator workspace settings form. Edits the three fields backing
// the queue right pane (Calendar/Drive embeds) + the scheduling link. Mirrors
// the VipSenders settings-page style (AppShell + bg-panel cards + @theme
// tokens). Full-replace PUT to /api/operator-settings.

type ToastMsg = { kind: 'success' | 'error'; text: string } | null;

export function WorkspaceSettings({
  initial,
  loadError,
}: {
  initial: OperatorSettings;
  loadError: string | null;
}) {
  const [bookingLink, setBookingLink] = useState(initial.booking_link);
  const [calendarSrc, setCalendarSrc] = useState(initial.calendar_embed_src);
  const [driveFolderId, setDriveFolderId] = useState(initial.drive_folder_id);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastMsg>(null);

  // Live confirmation that the pasted value resolves to an embeddable URL — the
  // same builders the right pane uses, so what the operator sees here is what
  // the pane will render.
  const calendarPreview = buildCalendarEmbedUrl(calendarSrc);
  const drivePreview = buildDriveEmbedUrl(driveFolderId);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/operator-settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          booking_link: bookingLink.trim(),
          calendar_embed_src: calendarSrc.trim(),
          drive_folder_id: driveFolderId.trim(),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          data?.error === 'validation_failed'
            ? (data.issues?.[0]?.message ?? 'Invalid value')
            : (data?.error ?? `Save failed (${res.status})`);
        throw new Error(msg);
      }
      const saved = data.settings as OperatorSettings;
      setBookingLink(saved.booking_link);
      setCalendarSrc(saved.calendar_embed_src);
      setDriveFolderId(saved.drive_folder_id);
      setToast({ kind: 'success', text: 'Workspace settings saved' });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell active={{ kind: 'surface', surface: 'settings' }}>
      <SettingsTabs active="workspace" />
      <header className="flex h-12 shrink-0 items-center border-b border-border-subtle bg-bg-panel px-4">
        <span className="font-mono text-[11px] text-ink-dim">Workspace</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-4 lg:p-6">
          <section>
            <h2 className="mb-1 font-sans text-base font-semibold">Workspace</h2>
            <p className="text-sm text-ink-muted">
              Configure the queue&apos;s Calendar / Drive side pane and your scheduling link. These
              embeds use Google&apos;s public iframe endpoints — separate from the read-only
              Calendar OAuth connection on the Integrations page.
            </p>
          </section>

          {loadError && (
            <div className="rounded-sm border border-accent-red/40 bg-accent-red/10 p-3 text-xs text-accent-red">
              <p className="mb-1 font-medium">Failed to load workspace settings</p>
              <p className="font-mono">{loadError}</p>
            </div>
          )}

          <form
            onSubmit={onSave}
            className="space-y-5 rounded-sm border border-border bg-bg-panel p-4"
          >
            {/* Booking link */}
            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-dim">
                <LinkIcon size={12} aria-hidden /> Scheduling link
              </span>
              <input
                type="url"
                value={bookingLink}
                onChange={(e) => setBookingLink(e.target.value)}
                placeholder="https://calendly.com/your-handle/intro"
                className="rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-dim"
              />
              <span className="text-[11px] text-ink-dim">
                Your booking URL (e.g. Calendly). Shown here for quick copy; must be an http(s) URL.
              </span>
            </label>

            {/* Calendar embed source */}
            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-dim">
                <Calendar size={12} aria-hidden /> Calendar embed source
              </span>
              <input
                type="text"
                value={calendarSrc}
                onChange={(e) => setCalendarSrc(e.target.value)}
                placeholder="you@gmail.com  ·  or a full calendar/embed URL"
                className="rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-dim"
              />
              <span className="text-[11px] text-ink-dim">
                A calendar ID / email, or a full embed URL. The source calendar&apos;s sharing must
                be &quot;See all event details&quot; or the agenda shows only &quot;Busy&quot;.
                {calendarSrc.trim() &&
                  (calendarPreview ? (
                    <span className="text-accent-green"> · resolves ✓</span>
                  ) : (
                    <span className="text-accent-red"> · unrecognized</span>
                  ))}
              </span>
            </label>

            {/* Drive folder id */}
            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-dim">
                <FolderOpen size={12} aria-hidden /> Drive folder ID
              </span>
              <input
                type="text"
                value={driveFolderId}
                onChange={(e) => setDriveFolderId(e.target.value)}
                placeholder="1AbCdEf…  (the part after /drive/folders/)"
                className="rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-dim"
              />
              <span className="text-[11px] text-ink-dim">
                A Google Drive folder ID (or full URL). The folder must be shared with anyone who
                should view it, or you must be signed into the same Google account in this browser.
                {driveFolderId.trim() &&
                  (drivePreview ? (
                    <span className="text-accent-green"> · resolves ✓</span>
                  ) : (
                    <span className="text-accent-red"> · unrecognized</span>
                  ))}
              </span>
            </label>

            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-sm bg-accent-orange px-4 py-2 font-sans text-sm font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save workspace settings'}
            </button>
          </form>
        </div>
      </div>

      {toast && <Toast {...toast} onDismiss={() => setToast(null)} />}
    </AppShell>
  );
}
