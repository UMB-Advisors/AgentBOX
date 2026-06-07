'use client';

import { Link2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { apiUrl } from '@/lib/api';

// MBOX-398 — shared empty/error chrome for the right-rail panels. Each data
// panel (Calendar / Contacts / Tasks) maps its typed `reason` to one of these.

export function CenteredNotice({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      {icon}
      <p className="text-sm font-medium text-ink">{title}</p>
      {children}
    </div>
  );
}

export function IntegrationsLink({ label = 'Open Integrations' }: { label?: string }) {
  return (
    <a
      href={apiUrl('/settings/integrations')}
      className="mt-3 inline-flex items-center gap-1.5 rounded-sm bg-accent-orange px-4 py-1.5 font-sans text-xs font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90"
    >
      <Link2 className="h-3.5 w-3.5" aria-hidden /> {label}
    </a>
  );
}

export function ConnectNotice({ icon, label }: { icon?: ReactNode; label: string }) {
  return (
    <CenteredNotice icon={icon} title={`Connect ${label}`}>
      <p className="max-w-xs text-xs text-ink-muted">{`Link your Google account to show ${label} here.`}</p>
      <IntegrationsLink />
    </CenteredNotice>
  );
}

// Map a non-ok, non-not_connected reason to a notice. (not_connected gets the
// richer ConnectNotice with the provider label, handled by each panel.)
export function reasonNotice(reason: string): ReactNode {
  if (reason === 'token_expired') {
    return (
      <CenteredNotice title="Reconnect needed">
        <p className="max-w-xs text-xs text-ink-muted">
          The Google grant expired or was revoked. Reconnect in Integrations.
        </p>
        <IntegrationsLink label="Reconnect" />
      </CenteredNotice>
    );
  }
  if (reason === 'rate_limited') {
    return (
      <CenteredNotice title="Rate limited">
        <p className="max-w-xs text-xs text-ink-muted">
          Google is throttling requests — try again shortly.
        </p>
      </CenteredNotice>
    );
  }
  return (
    <CenteredNotice title="Couldn’t load">
      <p className="max-w-xs text-xs text-ink-muted">Something went wrong fetching this panel.</p>
    </CenteredNotice>
  );
}
