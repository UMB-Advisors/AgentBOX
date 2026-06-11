import { AppShell } from '@/components/AppShell';
import { SettingsTabs } from '@/components/SettingsTabs';
import { apiUrl } from '@/lib/api';
import { type AccountRow, listAccounts } from '@/lib/queries-accounts';
import { listKbDocuments } from '@/lib/queries-kb';
import { getTopEditRateCategories, type TopEditRateCategory } from '@/lib/queries-status';
import { reconcileOnce } from '@/lib/rag/kb-reconciler';
import type { KbDocument } from '@/lib/types';
import { CategoryNudgeCard } from './components/CategoryNudgeCard';

export const dynamic = 'force-dynamic';

// STAQPRO-235 (KB Phase 2) — post-onboarding KB nudge UI.
//
// Surfaces the top-3 categories that are bleeding edits (read-only via
// v_override_rate from STAQPRO-233) with category-specific drag-drop
// targets. The operator decides which SOPs to upload — we don't
// auto-recommend (Linus hard-no on scanning). Existing /knowledge-base
// page stays as the catch-all "all my docs" surface; this is the
// metric-driven nudge.
//
// Onboarding state machine is **not** modified — this is post-onboarding
// (per Neo Architect: the operator can't intelligently pick docs on
// day-zero, they need signal first).
//
// Empty-state threshold: each category needs >= 5 disposed drafts in the
// 14-day v_override_rate window before it's offered as a nudge target.
// Below that, render the "come back after your first 20" message.
const MIN_SAMPLE_PER_CATEGORY = 5;
const MIN_TOTAL_FOR_SIGNAL = 20;

interface SettingsKbPageProps {
  searchParams?: Promise<{ account?: string | string[] }>;
}

function parseAccountId(raw: string | string[] | undefined): number | null {
  if (Array.isArray(raw)) return parseAccountId(raw[0]);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default async function SettingsKbPage(props: SettingsKbPageProps) {
  const searchParams = await props.searchParams;
  // Lazy reconciler boot hook — same pattern as /knowledge-base. Catches
  // stuck 'processing' rows from dashboard restarts.
  await reconcileOnce();

  const accountParam = parseAccountId(searchParams?.account);

  let topCategories: ReadonlyArray<TopEditRateCategory> = [];
  let docs: KbDocument[] = [];
  let accounts: AccountRow[] = [];
  let topErr: string | null = null;
  let docsErr: string | null = null;

  // MBOX-400 — connected inboxes for the per-account scope. Fails closed to an
  // empty list (→ no selector, all docs) so a transient error never blanks KB.
  try {
    accounts = await listAccounts();
  } catch {
    accounts = [];
  }
  const selectedAccountId =
    accountParam && accounts.some((a) => a.id === accountParam)
      ? accountParam
      : (accounts.find((a) => a.is_default)?.id ?? accounts[0]?.id ?? null);

  // Pull metrics + docs in parallel. Each fails closed independently so a
  // transient v_override_rate error doesn't blank the docs list and vice
  // versa.
  const [topResult, docsResult] = await Promise.allSettled([
    getTopEditRateCategories(3, MIN_SAMPLE_PER_CATEGORY),
    listKbDocuments({
      limit: 200,
      ...(selectedAccountId !== null ? { account_id: selectedAccountId } : {}),
    }),
  ]);
  if (topResult.status === 'fulfilled') topCategories = topResult.value;
  else
    topErr = topResult.reason instanceof Error ? topResult.reason.message : 'metrics unavailable';
  if (docsResult.status === 'fulfilled') docs = docsResult.value;
  else docsErr = docsResult.reason instanceof Error ? docsResult.reason.message : 'kb unavailable';

  const showAccount = accounts.length > 1;

  const totalDisposed = topCategories.reduce((acc, c) => acc + c.disposed, 0);
  const insufficientSignal = topCategories.length === 0 || totalDisposed < MIN_TOTAL_FOR_SIGNAL;

  return (
    <AppShell active={{ kind: 'surface', surface: 'settings' }}>
      <SettingsTabs active="kb" />
      <div className="mx-auto w-full max-w-4xl overflow-y-auto p-4 lg:p-6">
        <section className="mb-6">
          <h2 className="mb-1 font-sans text-base font-semibold">
            Knowledge base — improve your drafts
          </h2>
          <p className="text-sm text-ink-muted">
            Drop SOPs, FAQs, or playbooks for the categories where your drafts get rewritten the
            most. Files stay on this appliance — they're embedded locally and only the matching
            snippet is ever shown to the LLM.
          </p>
        </section>

        {/* MBOX-400 — per-inbox KB scope (multi-account only). Server-side links
            keep this page free of client JS. */}
        {showAccount && (
          <section className="mb-6 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
              Inbox
            </span>
            {accounts.map((a) => (
              <a
                key={a.id}
                href={apiUrl(`/settings/kb?account=${a.id}`)}
                className={`rounded-sm border px-2 py-1 font-sans text-xs ${
                  a.id === selectedAccountId
                    ? 'border-border bg-bg-deep text-ink'
                    : 'border-border-subtle text-ink-muted hover:bg-bg-deep hover:text-ink'
                }`}
              >
                {a.display_label?.trim() || a.email_address}
              </a>
            ))}
          </section>
        )}

        {topErr && (
          <div className="mb-4 rounded-sm border border-accent-orange/40 bg-accent-orange/10 p-3 text-xs text-accent-orange">
            Couldn't load drafting metrics — showing the catch-all upload only.{' '}
            <span className="font-mono">{topErr}</span>
          </div>
        )}

        {insufficientSignal ? (
          // ─── Empty state ──────────────────────────────────────────
          // Per the issue's acceptance criteria: when v_override_rate has
          // fewer than 5 drafts in any category (or fewer than 20 total),
          // suppress the targeted nudges entirely and tell the operator
          // to come back later. No false-precision suggestions.
          <section className="mb-6 rounded-sm border border-border-subtle bg-bg-panel p-4">
            <h3 className="mb-2 font-sans text-sm font-semibold">Not enough drafts yet</h3>
            <p className="text-sm text-ink-muted">
              Come back after your first 20 drafts and we'll point you at the categories that need
              the most help. For now, you can upload any docs you want via the catch-all knowledge
              base.
            </p>
            <a
              href={apiUrl('/knowledge-base')}
              className="mt-3 inline-block rounded-sm border border-border-subtle px-3 py-1 font-mono text-xs hover:bg-bg-deep"
            >
              Go to knowledge base →
            </a>
          </section>
        ) : (
          // ─── Targeted nudges ─────────────────────────────────────
          <section className="mb-6">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Top {topCategories.length} categor{topCategories.length === 1 ? 'y' : 'ies'} by edit
              rate
            </h2>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {topCategories.map((c) => (
                <CategoryNudgeCard
                  key={c.classification_category}
                  category={c.classification_category}
                  edit_reject_rate={c.edit_reject_rate}
                  disposed={c.disposed}
                />
              ))}
            </div>
            <p className="mt-3 text-xs text-ink-dim">
              Source: <code className="font-mono">mailbox.v_override_rate</code> (last 14 days,
              minimum {MIN_SAMPLE_PER_CATEGORY} disposed drafts per category).
            </p>
          </section>
        )}

        <section className="mb-6">
          <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
            Existing documents
          </h2>
          {docsErr ? (
            <div className="rounded-sm border border-accent-red/40 bg-accent-red/10 p-3 text-xs text-accent-red">
              <p className="mb-1 font-medium">Failed to load knowledge base</p>
              <p className="font-mono">{docsErr}</p>
            </div>
          ) : docs.length === 0 ? (
            <p className="rounded-sm border border-border-subtle bg-bg-panel p-3 text-sm text-ink-muted">
              No documents uploaded yet. Drop a file on a category above or use the{' '}
              <a className="underline hover:text-ink" href={apiUrl('/knowledge-base')}>
                catch-all knowledge base
              </a>
              .
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle rounded-sm border border-border-subtle bg-bg-panel">
              {docs.map((d) => (
                <li key={d.id} className="flex items-baseline justify-between p-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-sans text-sm">{d.title}</div>
                    <div className="font-mono text-[11px] text-ink-dim">
                      {d.filename} · {d.chunk_count} chunks
                    </div>
                  </div>
                  <span
                    className={`ml-3 font-mono text-[11px] ${
                      d.status === 'ready'
                        ? 'text-accent-green'
                        : d.status === 'failed'
                          ? 'text-accent-red'
                          : 'text-ink-dim'
                    }`}
                  >
                    {d.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-ink-dim">
            Need to delete or retry?{' '}
            <a className="underline hover:text-ink" href={apiUrl('/knowledge-base')}>
              Manage all documents →
            </a>
          </p>
        </section>
      </div>
    </AppShell>
  );
}
