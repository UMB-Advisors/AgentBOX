import { listVipSenders, type VipSender } from '@/lib/queries-vip';
import { VipSenders } from './VipSenders';

export const dynamic = 'force-dynamic';

// MBOX-134 — VIP sender list management surface. Server-loads the current list
// and hands it to the client component for add/remove. Backs the urgency
// engine's 'vip' signal (lib/urgency.ts): any queued draft from a listed sender
// is flagged urgent.

export default async function VipSettingsPage() {
  let initial: VipSender[] = [];
  let error: string | null = null;

  try {
    initial = await listVipSenders();
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load VIP senders';
  }

  return <VipSenders initial={initial} loadError={error} />;
}
