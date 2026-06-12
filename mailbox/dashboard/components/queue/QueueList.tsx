'use client';

// P1b (MBOX-162) — queue list panel content. Extracted from QueueClient.tsx.
// Receives all data and handlers as props; owns no fetch.

import { apiUrl } from '@/lib/api';
import type { AccountRef, DraftWithMessage } from '@/lib/types';
import { DraftCard } from '../DraftCard';
import { EmptyState } from '../EmptyState';
import type { CooldownState } from '../GmailCooldownBanner';
import { NewDraftsBanner } from '../NewDraftsBanner';
import { StuckApproved } from '../StuckApproved';
import type { Mode } from './utils';

interface QueueListProps {
  mode: Mode;
  folder: string;
  visibleList: DraftWithMessage[];
  stuckApprovedFiltered: DraftWithMessage[];
  newCount: number;
  sortOrder: 'newest' | 'oldest';
  accountFilter: number | undefined;
  accounts: AccountRef[];
  showAccount: boolean;
  selected: DraftWithMessage | null;
  rowBusyId: number | null;
  cooldown: CooldownState;
  busyRetryId: number | null;
  onSortNewest: () => void;
  onSortOldest: () => void;
  onSelect: (id: number) => void;
  onDismissNewDrafts: () => void;
  onAccountFilterChange: (next: number | undefined) => void;
  onRetry: (draft: DraftWithMessage) => void;
  onClearLock: (draft: DraftWithMessage) => void;
  onArchive: (draft: DraftWithMessage) => void;
  onDelete: (draft: DraftWithMessage) => void;
  onMarkRead: (draft: DraftWithMessage) => void;
  onSnooze: (draft: DraftWithMessage, untilISO: string) => void;
}

export function QueueList({
  mode,
  folder,
  visibleList,
  stuckApprovedFiltered,
  newCount,
  sortOrder,
  accountFilter,
  accounts,
  showAccount,
  selected,
  rowBusyId,
  cooldown,
  busyRetryId,
  onSortNewest,
  onSortOldest,
  onSelect,
  onDismissNewDrafts,
  onAccountFilterChange,
  onRetry,
  onClearLock,
  onArchive,
  onDelete,
  onMarkRead,
  onSnooze,
}: QueueListProps) {
  return (
    <>
      {/* MBOX-360 (MBOX-162 V3) — account filter. Only rendered when the box
          serves more than one inbox; single-account boxes never see it. "All
          inboxes" clears the filter (cross-account unified view). */}
      {accounts.length > 1 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-panel px-3 py-1.5 font-mono text-[11px] text-ink-dim">
          <label htmlFor="account-filter" className="shrink-0">
            Inbox
          </label>
          <select
            id="account-filter"
            value={accountFilter ?? ''}
            onChange={(e) =>
              onAccountFilterChange(e.target.value ? Number(e.target.value) : undefined)
            }
            className="min-w-0 flex-1 rounded-sm border border-border bg-bg-deep px-1.5 py-0.5 text-ink"
          >
            <option value="">All inboxes</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_label || a.email_address}
              </option>
            ))}
          </select>
          {/* MBOX-366 (MBOX-162 V5) — in-context link to the registry. */}
          <a
            href={apiUrl('/settings/accounts')}
            className="shrink-0 text-ink-muted underline underline-offset-2 hover:text-ink"
          >
            Manage
          </a>
        </div>
      )}

      {/* STAQPRO-331 #8 — sort selector (active folder only). Lets the
          operator flip to oldest-first so overdue rows surface at the top of
          the list. Hidden in archive folders. */}
      {mode === 'active' && visibleList.length > 1 && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border-subtle bg-bg-panel px-3 py-1.5 font-mono text-[11px] text-ink-dim">
          <span>Sort</span>
          <button
            type="button"
            onClick={onSortNewest}
            className={
              sortOrder === 'newest'
                ? 'text-ink underline underline-offset-2'
                : 'text-ink-muted hover:text-ink'
            }
          >
            newest
          </button>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={onSortOldest}
            className={
              sortOrder === 'oldest'
                ? 'text-ink underline underline-offset-2'
                : 'text-ink-muted hover:text-ink'
            }
          >
            oldest
          </button>
        </div>
      )}

      {mode === 'active' && (stuckApprovedFiltered.length > 0 || newCount > 0) && (
        <div className="space-y-2 border-b border-border-subtle p-2">
          <StuckApproved
            drafts={stuckApprovedFiltered}
            busyId={busyRetryId}
            onRetry={onRetry}
            onClearLock={onClearLock}
            cooldownActive={cooldown.is_active}
            cooldownSafeAt={cooldown.recommended_safe_at}
          />
          <NewDraftsBanner count={newCount} onDismiss={onDismissNewDrafts} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleList.length === 0 ? (
          mode === 'active' ? (
            <EmptyState />
          ) : (
            <div className="flex h-40 items-center justify-center text-sm text-ink-dim">
              No {folder} drafts yet
            </div>
          )
        ) : (
          <ul className="divide-y divide-border-subtle">
            {visibleList.map((draft) => (
              <li key={draft.id}>
                <DraftCard
                  draft={draft}
                  isSelected={draft.id === selected?.id}
                  mode={mode === 'active' ? 'pending' : 'sent'}
                  showAccount={showAccount}
                  onSelect={() => onSelect(draft.id)}
                  {...(mode === 'active'
                    ? {
                        actionsBusy: rowBusyId === draft.id,
                        onArchive: () => onArchive(draft),
                        onDelete: () => onDelete(draft),
                        onMarkRead: () => onMarkRead(draft),
                        onSnooze: (untilISO: string) => onSnooze(draft, untilISO),
                      }
                    : {})}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
