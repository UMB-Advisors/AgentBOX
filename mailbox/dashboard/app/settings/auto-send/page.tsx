import { listAutoSendRules } from '@/lib/queries-auto-send';
import type { AutoSendRule } from '@/lib/types';
import { AutoSendRules } from './AutoSendRules';

export const dynamic = 'force-dynamic';

// MBOX-351 / FR-23 §1 — auto-send rule management surface. Server-loads the
// current rule set (priority, id order) and hands it to the client component
// for create/edit/delete. The engine (migration 032 + lib/auto-send/rules.ts
// evaluator) is unchanged — this is the operator UI that replaces hand-editing
// JSON against /api/auto-send-rules. Mirrors settings/vip's page/component
// split.

export default async function AutoSendSettingsPage() {
  let initial: AutoSendRule[] = [];
  let error: string | null = null;

  try {
    initial = await listAutoSendRules();
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load auto-send rules';
  }

  return <AutoSendRules initial={initial} loadError={error} />;
}
