import { KnowledgeBaseClient } from '@/components/KnowledgeBaseClient';
import { type AccountRow, listAccounts } from '@/lib/queries-accounts';
import { listKbDocuments } from '@/lib/queries-kb';
import { reconcileOnce } from '@/lib/rag/kb-reconciler';
import type { KbDocument } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface KnowledgeBasePageProps {
  searchParams?: { account?: string | string[] };
}

function parseAccountId(raw: string | string[] | undefined): number | null {
  if (Array.isArray(raw)) return parseAccountId(raw[0]);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// STAQPRO-148 — operator-facing KB page. Server-renders the initial doc
// list then hands off to the client component for upload + polling.
//
// reconcileOnce() also fires from GET /api/kb-documents (the route the
// client uses for refresh). Calling it here too is harmless (idempotent +
// once-per-process latch) and means the first page render after a
// dashboard restart catches stuck rows immediately.

export default async function KnowledgeBasePage({ searchParams }: KnowledgeBasePageProps) {
  await reconcileOnce();

  const accountParam = parseAccountId(searchParams?.account);

  let initialRows: KbDocument[] = [];
  let accounts: AccountRow[] = [];
  let selectedAccountId: number | null = null;
  let error: string | null = null;
  try {
    accounts = await listAccounts();
    // MBOX-400 — scope the corpus to the chosen inbox (?account=), else the
    // default account so the picker and SSR list always agree.
    selectedAccountId =
      accountParam && accounts.some((a) => a.id === accountParam)
        ? accountParam
        : (accounts.find((a) => a.is_default)?.id ?? accounts[0]?.id ?? null);
    initialRows = await listKbDocuments({
      limit: 200,
      ...(selectedAccountId !== null ? { account_id: selectedAccountId } : {}),
    });
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load knowledge base';
  }

  if (error) {
    return (
      <main className="flex h-screen flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-border-subtle bg-bg-panel px-4">
          <h1 className="font-sans text-sm font-semibold tracking-tight">MailBox One</h1>
        </header>
        <div className="m-4 rounded-sm border border-accent-red/40 bg-accent-red/10 p-4 text-sm text-accent-red">
          <p className="mb-1 font-medium">Failed to load knowledge base</p>
          <p className="font-mono text-xs">{error}</p>
        </div>
      </main>
    );
  }

  return (
    <KnowledgeBaseClient
      initialRows={initialRows}
      accounts={accounts}
      selectedAccountId={selectedAccountId}
    />
  );
}
