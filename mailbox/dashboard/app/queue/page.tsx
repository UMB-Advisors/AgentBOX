import type { CooldownState } from '@/components/GmailCooldownBanner';
import { QueueClient } from '@/components/QueueClient';
import { getHighPriorityQueue, listDrafts } from '@/lib/queries';
import { type AccountRow, listAccounts } from '@/lib/queries-accounts';
import { getOperatorSettings } from '@/lib/queries-operator-settings';
import { getGmailCooldown } from '@/lib/queries-system-state';
import type { DraftStatus, DraftWithMessage, OperatorSettings } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EMPTY_COOLDOWN: CooldownState = {
  is_active: false,
  until: null,
  set_at: null,
  recommended_safe_at: null,
};

// P4 (MBOX-162) — operator_settings feed the right pane's Calendar/Drive
// embeds. A read failure must NOT take down the queue, so it loads with an
// all-empty fallback (the pane then renders a configure CTA).
const EMPTY_OPERATOR_SETTINGS: OperatorSettings = {
  booking_link: '',
  calendar_embed_src: '',
  drive_folder_id: '',
};

// Folder keys come from the left rail (components/Sidebar.tsx). Each folder
// maps to a different `mailbox.drafts.status` slice. STAQPRO-382 Phase 2a-2
// (2026-05-15) wires the URL ?folder= search param into the server fetch so
// each rail click drops to the right list.
type FolderKey = 'queue' | 'priority' | 'approved' | 'sent' | 'rejected' | 'all';

const VALID_FOLDERS: FolderKey[] = ['queue', 'priority', 'approved', 'sent', 'rejected', 'all'];

function parseFolder(raw: string | string[] | undefined): FolderKey {
  if (Array.isArray(raw)) return parseFolder(raw[0]);
  if (raw && (VALID_FOLDERS as readonly string[]).includes(raw)) return raw as FolderKey;
  return 'queue';
}

// Status slice per folder. 'queue' shows the operator action list
// (pending + edited). 'all' aggregates every actionable status — useful for
// a single-pane view across the board.
function statusesForFolder(folder: FolderKey): DraftStatus[] {
  switch (folder) {
    case 'queue':
      return ['pending', 'edited'];
    case 'priority':
      // Same actionable slice as 'queue'; getHighPriorityQueue narrows it to
      // drafts firing ≥1 urgency signal across all accounts.
      return ['pending', 'edited'];
    case 'approved':
      return ['approved'];
    case 'sent':
      return ['sent'];
    case 'rejected':
      return ['rejected'];
    case 'all':
      return ['pending', 'edited', 'approved', 'sent', 'rejected'];
  }
}

// MBOX-360 (MBOX-162 V3) — parse the ?account=<id> filter. Non-numeric /
// absent → undefined (the cross-account view).
function parseAccountId(raw: string | string[] | undefined): number | undefined {
  if (Array.isArray(raw)) return parseAccountId(raw[0]);
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

interface QueuePageProps {
  searchParams?: { folder?: string | string[]; account?: string | string[] };
}

export default async function QueuePage({ searchParams }: QueuePageProps) {
  const folder = parseFolder(searchParams?.folder);
  // MBOX-360 (MBOX-162 V3) — the active account filter (undefined = all inboxes).
  const accountId = parseAccountId(searchParams?.account);

  // The queue folder still needs the approved-list separately to power the
  // StuckApproved banner — approved drafts that errored on Gmail Reply leave
  // the row at status='approved' (STAQPRO-202 / STAQPRO-271). Other folders
  // don't render that banner.
  const wantsStuck = folder === 'queue';
  let initialList: DraftWithMessage[] = [];
  let initialStuck: DraftWithMessage[] = [];
  let initialCooldown: CooldownState = EMPTY_COOLDOWN;
  let initialAccounts: AccountRow[] = [];
  let operatorSettings: OperatorSettings = EMPTY_OPERATOR_SETTINGS;
  let error: string | null = null;

  try {
    const [list, stuck, cooldown, accounts, settings] = await Promise.all([
      // MBOX-360 (MBOX-162 V3) — the list respects the active account filter.
      folder === 'priority'
        ? getHighPriorityQueue(50, process.env, accountId)
        : listDrafts(statusesForFolder(folder), 50, accountId),
      // StuckApproved is a cross-account safety surface — never hidden by the
      // account filter, so the operator always sees every stuck send.
      wantsStuck ? listDrafts(['approved'], 50) : Promise.resolve([] as DraftWithMessage[]),
      // STAQPRO-331 #5 — initial cooldown read for the banner. Client-side
      // polling refreshes it alongside the drafts list.
      getGmailCooldown(),
      // MBOX-360 — connected inboxes for the account selector.
      listAccounts(),
      // P4 (MBOX-162) — right-pane embed config. Degrades to empty on failure
      // so the queue still renders (pane shows a configure CTA).
      getOperatorSettings().catch(() => EMPTY_OPERATOR_SETTINGS),
    ]);
    initialList = list;
    initialStuck = stuck;
    initialAccounts = accounts;
    operatorSettings = settings;
    initialCooldown = {
      is_active: cooldown.isActive,
      until: cooldown.until?.toISOString() ?? null,
      set_at: cooldown.set_at?.toISOString() ?? null,
      recommended_safe_at: cooldown.recommended_safe_at?.toISOString() ?? null,
    };
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load drafts';
  }

  if (error) {
    return (
      <main className="flex h-screen flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-border-subtle bg-bg-panel px-4">
          <h1 className="font-sans text-sm font-semibold tracking-tight">MailBox One</h1>
        </header>
        <div className="m-4 rounded-sm border border-accent-red/40 bg-accent-red/10 p-4 text-sm text-accent-red">
          <p className="mb-1 font-medium">Failed to load drafts</p>
          <p className="font-mono text-xs">{error}</p>
        </div>
      </main>
    );
  }

  // P3 (MBOX-162) — gate the redraft-with-prompt button on the same env flag the
  // /api/internal/draft-redraft endpoint enforces. SSR-read so it's resolved at
  // request time (force-dynamic), keeping the button hidden until the loop is
  // validated on M1.
  const redraftEnabled = process.env.MAILBOX_REDRAFT_ENABLED === '1';

  return (
    <QueueClient
      folder={folder}
      initialList={initialList}
      initialStuck={initialStuck}
      initialCooldown={initialCooldown}
      redraftEnabled={redraftEnabled}
      accounts={initialAccounts}
      initialAccountId={accountId}
      calendarSrc={operatorSettings.calendar_embed_src}
      driveFolderId={operatorSettings.drive_folder_id}
    />
  );
}
