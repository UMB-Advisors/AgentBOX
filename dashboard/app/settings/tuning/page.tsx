import { type AccountRow, listAccounts } from '@/lib/queries-accounts';
import { getPersona } from '@/lib/queries-persona';
import { listPromptRules, type PromptRule } from '@/lib/queries-prompt-rules';
import { DEFAULT_STYLE_PROFILE, hasLiteralToneOverride, markersToStyle } from '@/lib/tuning/style';
import { TuningSettings } from './TuningSettings';

export const dynamic = 'force-dynamic';

// MBOX-162 P5a/P5b (sandbox UI port §P5) — Tuning surface. Server-loads the
// persona row (Style tab seed) and the operator's drafting guidelines
// (Guidelines tab seed). The Style tab is a friendly editor over the same
// markers the legacy /settings/persona JSON editor exposes; saving merges
// (never clobbers) so the two surfaces coexist.
//
// MBOX-374 — per-account. `?account=<id>` selects which inbox to tune (mirrors
// the V3 queue convention). Absent/unknown → the default account. The persona
// + prompt_rules reads are scoped to the resolved account, matching the
// draft-time resolution (getPersonaContext / listEnabledPromptRules per account).
//
// P5c (raw-prompt editor) is deferred.

// Resolve the requested ?account= to a real connected account id; fall back to
// the default account (or the first row) when absent or unknown.
function resolveSelectedAccount(
  raw: string | string[] | undefined,
  accounts: AccountRow[],
): number | undefined {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const requested = first ? Number.parseInt(first, 10) : Number.NaN;
  if (Number.isFinite(requested) && accounts.some((a) => a.id === requested)) {
    return requested;
  }
  return (accounts.find((a) => a.is_default) ?? accounts[0])?.id;
}

interface TuningPageProps {
  searchParams?: { account?: string | string[] };
}

export default async function TuningSettingsPage({ searchParams }: TuningPageProps) {
  let initialStyle = { ...DEFAULT_STYLE_PROFILE };
  let toneOverride = false;
  let initialRules: PromptRule[] = [];
  let accounts: AccountRow[] = [];
  let selectedAccountId: number | undefined;
  let loadError: string | null = null;

  try {
    accounts = await listAccounts();
    selectedAccountId = resolveSelectedAccount(searchParams?.account, accounts);

    const [persona, rules] = await Promise.all([
      getPersona(selectedAccountId),
      listPromptRules(selectedAccountId),
    ]);
    const markers = persona?.statistical_markers ?? {};
    initialStyle = markersToStyle(markers);
    toneOverride = hasLiteralToneOverride(markers);
    initialRules = rules;
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Failed to load tuning settings';
  }

  return (
    <TuningSettings
      accounts={accounts}
      selectedAccountId={selectedAccountId}
      initialStyle={initialStyle}
      initialRules={initialRules}
      toneOverride={toneOverride}
      loadError={loadError}
    />
  );
}
