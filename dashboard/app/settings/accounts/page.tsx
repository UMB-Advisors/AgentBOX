import { type AccountDetail, listAccountsDetailed } from '@/lib/queries-accounts';
import { AccountsSettings } from './AccountsSettings';

export const dynamic = 'force-dynamic';

// MBOX-366 (MBOX-162 V5) — connected-inbox registry management surface. Server-
// loads the accounts on this appliance and hands them to the client component
// for add / relabel / set-default / remove. Operationalizes V1–V3: the moment a
// 2nd inbox row exists, the queue's account selector/badge (V3) and per-account
// persona/RAG scoping (V2) engage. Mirrors settings/vip's page/component split.

export default async function AccountsSettingsPage() {
  let initial: AccountDetail[] = [];
  let error: string | null = null;

  try {
    initial = await listAccountsDetailed();
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load accounts';
  }

  return <AccountsSettings initial={initial} loadError={error} />;
}
