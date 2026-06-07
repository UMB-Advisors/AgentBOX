import { getOperatorSettings } from '@/lib/queries-operator-settings';
import type { OperatorSettings } from '@/lib/types';
import { WorkspaceSettings } from './WorkspaceSettings';

export const dynamic = 'force-dynamic';

// MBOX-162 P4 (sandbox UI port §4) — workspace settings surface. Server-loads
// the operator_settings singleton and hands it to the client form. Backs the
// queue right pane's Calendar/Drive embeds + the operator's scheduling link.

export default async function WorkspaceSettingsPage() {
  let initial: OperatorSettings = {
    booking_link: '',
    calendar_embed_src: '',
    drive_folder_id: '',
  };
  let error: string | null = null;

  try {
    initial = await getOperatorSettings();
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load workspace settings';
  }

  return <WorkspaceSettings initial={initial} loadError={error} />;
}
