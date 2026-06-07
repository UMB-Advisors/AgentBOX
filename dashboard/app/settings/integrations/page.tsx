import { getConnection, type OAuthConnection } from '@/lib/oauth/google';
import { GoogleIntegrations } from './GoogleIntegrations';

export const dynamic = 'force-dynamic';

// MBOX-130 + MBOX-129 — Google integrations settings surface. Server-loads the
// current connection status for the Calendar (MBOX-130 pre-read) and Tasks
// (MBOX-129 handoff) providers and hands them to the client component for
// connect/disconnect. Mirrors the VIP settings page shape (server load → client
// component). The Drive connector (STAQPRO-210) will slot in here as a third
// card with the same layout when it lands.

export default async function IntegrationsSettingsPage() {
  let calendar: OAuthConnection | null = null;
  let tasks: OAuthConnection | null = null;
  let contacts: OAuthConnection | null = null;
  let error: string | null = null;

  try {
    [calendar, tasks, contacts] = await Promise.all([
      getConnection('google_calendar'),
      getConnection('google_tasks'),
      getConnection('google_contacts'),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load integrations';
  }

  return (
    <GoogleIntegrations calendar={calendar} tasks={tasks} contacts={contacts} loadError={error} />
  );
}
