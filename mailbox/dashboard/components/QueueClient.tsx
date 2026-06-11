'use client';

import { useEffect, useState } from 'react';
import type { AccountRef, DraftWithMessage } from '@/lib/types';
import type { ActionKind } from './ActionButtons';
import type { CooldownState } from './GmailCooldownBanner';
import { STUCK_APPROVED_THRESHOLD_MS } from './queue/constants';
import { QueueDetail } from './queue/QueueDetail';
import { QueueList } from './queue/QueueList';
import { QueueShell } from './queue/QueueShell';
import { useKeyboardNav } from './queue/useKeyboardNav';
import { useQueueActions } from './queue/useQueueActions';
import { useQueuePolling } from './queue/useQueuePolling';
import { useRightPane } from './queue/useRightPane';
import { type FolderKey, modeForFolder, type ToastMsg } from './queue/utils';

type Busy = { draftId: number; kind: ActionKind | 'retry' } | null;

interface Props {
  folder: FolderKey;
  initialList: DraftWithMessage[];
  initialStuck: DraftWithMessage[];
  initialCooldown: CooldownState;
  // P3 (MBOX-162) — SSR-resolved MAILBOX_REDRAFT_ENABLED flag. Gates the
  // redraft button's visibility (the endpoint also 403s when off).
  redraftEnabled: boolean;
  // P4 (MBOX-162) — operator_settings values feeding the right pane's
  // Calendar/Drive embeds. SSR-loaded by app/queue/page.tsx; '' when unset
  // (the pane renders a configure CTA linking to /settings/workspace).
  calendarSrc: string;
  driveFolderId: string;
  // MBOX-360 (MBOX-162 V3) — connected inboxes for the account selector, and
  // the SSR-resolved active filter (undefined = all inboxes). AccountRef is a
  // type-only import so no server DB code leaks into the client bundle.
  accounts: AccountRef[];
  initialAccountId?: number;
}

export function QueueClient({
  folder,
  initialList,
  initialStuck,
  initialCooldown,
  redraftEnabled,
  calendarSrc,
  driveFolderId,
  accounts,
  initialAccountId,
}: Props) {
  const mode = modeForFolder(folder);
  const [drafts, setDrafts] = useState(initialList);
  const [stuckApproved, setStuckApproved] = useState(initialStuck);
  // STAQPRO-331 #5 — system-wide Gmail rate-limit cooldown. SSR-seeded so
  // the banner appears on first paint; refreshed every POLL_INTERVAL_MS
  // alongside the drafts list.
  const [cooldown, setCooldown] = useState<CooldownState>(initialCooldown);
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<Busy>(null);
  // MBOX-369 — per-row inbox action (archive/delete/mark-read/snooze) in flight,
  // keyed on draft.id. Separate from `busy` (which tracks approve/edit/reject)
  // so a row action doesn't disable the detail-pane ActionButtons and vice versa.
  const [rowBusyId, setRowBusyId] = useState<number | null>(null);
  // P2 (MBOX-162) — inline edit mode for the selected draft (replaces the
  // EditModal overlay). Controlled here so the `e` keyboard shortcut can
  // toggle it; reset whenever the selected draft changes (see effect below).
  const [isEditing, setIsEditing] = useState(false);
  // P3 (MBOX-162) — when the operator Applies a redraft, the inline editor
  // opens pre-seeded with the redrafted text (not the stored body). Cleared
  // whenever edit mode exits or the selection changes.
  const [redraftSeedBody, setRedraftSeedBody] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMsg>(null);
  const [newCount, setNewCount] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(
    initialList.length > 0 ? initialList[0].id : null,
  );
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  // STAQPRO-331 #1 — controlled popover state so the 'x' keyboard shortcut
  // can open it without reaching into DraftDetail's DOM.
  const [rejectPopoverOpen, setRejectPopoverOpen] = useState(false);
  // STAQPRO-331 #7 — '?' toggles a keyboard-shortcut cheatsheet overlay.
  // Discoverability for the operator who didn't read the docs.
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  // STAQPRO-331 #8 — pending-queue sort order. 'newest' is the default
  // (matches the listDrafts ORDER BY created_at DESC server-side sort);
  // 'oldest' surfaces stale/overdue drafts at the top.
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  // MBOX-360 (MBOX-162 V3) — account filter for the unified queue. undefined =
  // all inboxes; a number narrows to one connected account. SSR-seeded from the
  // ?account= param so a deep-linked/reloaded filter survives.
  const [accountFilter, setAccountFilter] = useState<number | undefined>(initialAccountId);

  // P1b (MBOX-162) — collapsible right pane. State + localStorage persistence
  // extracted to useRightPane.
  const { rightPaneOpen, toggleRightPane } = useRightPane();

  // Status slice per folder — mirrors the server's statusesForFolder() in
  // app/queue/page.tsx. Kept in sync by hand; the wire shape is the same.
  const statusQuery = (() => {
    switch (folder) {
      case 'queue':
        return 'pending,edited';
      case 'priority':
        return 'pending,edited';
      case 'approved':
        return 'approved';
      case 'sent':
        return 'sent';
      case 'rejected':
        return 'rejected';
      case 'all':
        return 'pending,edited,approved,sent,rejected';
    }
  })();

  // MBOX-162 V3 — the priority folder polls the urgency-aware list endpoint so
  // the client refresh stays consistent with the SSR fetch (getHighPriorityQueue).
  const urgentParam = folder === 'priority' ? '&urgent=1' : '';
  // MBOX-360 (MBOX-162 V3) — badge the owning mailbox whenever the box serves
  // more than one inbox (so any folder reads as cross-account), and always on
  // the Priority view. Single-account boxes stay uncluttered.
  const showAccount = accounts.length > 1 || folder === 'priority';
  // MBOX-360 — narrow the list fetch to the selected inbox when a filter is set.
  const accountParam = accountFilter !== undefined ? `&account=${accountFilter}` : '';

  const wantsStuck = folder === 'queue';

  // Polling + visibility-aware refetch extracted to useQueuePolling.
  const { fetchData } = useQueuePolling({
    folder,
    mode,
    statusQuery,
    urgentParam,
    accountParam,
    accountFilter,
    wantsStuck,
    initialList,
    setDrafts,
    setStuckApproved,
    setCooldown,
    setNewCount,
  });

  // MBOX-360 — apply a new account filter: client state + URL sync (deep-link /
  // reload preserves it) via replaceState, avoiding a full SSR navigation. The
  // effect above repaints the list.
  const handleAccountFilterChange = (next: number | undefined) => {
    setAccountFilter(next);
    try {
      const url = new URL(window.location.href);
      if (next === undefined) url.searchParams.delete('account');
      else url.searchParams.set('account', String(next));
      window.history.replaceState(null, '', url.toString());
    } catch {
      // URL sync is best-effort; the client-state filter still applies.
    }
  };

  // P2 — exit inline edit when the selected draft changes (operator clicks a
  // different row, or approve/reject auto-advances). An in-progress unsaved
  // edit is discarded, matching the old modal's close-on-switch behavior.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on selection change only.
  useEffect(() => {
    setIsEditing(false);
    setRedraftSeedBody(null);
  }, [selectedId]);

  const dismissToast = () => setToast(null);
  const dismissNewDrafts = () => setNewCount(0);

  // STAQPRO-331 #8 — apply pending-queue sort. Server returns newest-first
  // (created_at DESC); 'oldest' flips it so overdue rows surface at the top.
  // Archive folders (approved/sent/rejected) stay in server order — there's
  // no actionable "oldest first" mental model for already-finalized rows.
  const visibleList = (() => {
    if (mode !== 'active') return drafts;
    const filtered = drafts.filter((d) => !removed.has(d.id));
    if (sortOrder !== 'oldest') return filtered;
    return [...filtered].sort((a, b) => {
      const at = new Date(a.created_at).getTime();
      const bt = new Date(b.created_at).getTime();
      return at - bt;
    });
  })();
  // STAQPRO-202 — drafts stuck at status='approved' beyond the webhook
  // timeout window. Sole operator recovery surface for send-side failures
  // (the 'failed' status was retired in migration 016 — see CLAUDE.md
  // Conventions > Draft status state machine). The stuckApproved state was
  // fetched separately by the server for the queue folder only; we apply
  // the staleness threshold here to filter to actually-stuck rows.
  const stuckApprovedFiltered = stuckApproved.filter((d) => {
    if (d.status !== 'approved') return false;
    const updated = d.updated_at ? new Date(d.updated_at).getTime() : NaN;
    if (!Number.isFinite(updated)) return false;
    return Date.now() - updated > STUCK_APPROVED_THRESHOLD_MS;
  });
  const selected = visibleList.find((d) => d.id === selectedId) ?? visibleList[0] ?? null;
  const busyKindFor = (id: number): ActionKind | null =>
    busy?.draftId === id && busy.kind !== 'retry' ? (busy.kind as ActionKind) : null;
  const busyRetryId = busy?.kind === 'retry' ? busy.draftId : null;

  // Action handlers extracted to useQueueActions (Step 4, PLAN-013).
  const {
    fireAction,
    fireInboxAction,
    fireReject,
    fireRetry,
    fireClearLock,
    fireForceResumeCooldown,
    onEditSave,
    fireReclassify,
    onRedraftApply,
    exitEdit,
  } = useQueueActions({
    mode,
    drafts,
    removed,
    selected,
    setBusy,
    setRemoved,
    setSelectedId,
    setRowBusyId,
    setDrafts,
    setToast,
    setIsEditing,
    setRedraftSeedBody,
    setCooldown,
    fetchData,
  });

  // Keyboard navigation extracted to useKeyboardNav.
  useKeyboardNav({
    mode,
    isEditing,
    shortcutsHelpOpen,
    rejectPopoverOpen,
    selectedId,
    visibleList,
    selected,
    busy,
    setSelectedId,
    setIsEditing,
    setShortcutsHelpOpen,
    setRejectPopoverOpen,
    fireAction,
  });

  // Folder-specific count label for the header chip.
  const countLabel = (() => {
    switch (folder) {
      case 'queue':
        return 'pending';
      case 'priority':
        return 'high-priority';
      case 'approved':
        return 'approved';
      case 'sent':
        return 'sent';
      case 'rejected':
        return 'rejected';
      case 'all':
        return 'drafts';
    }
  })();

  return (
    <QueueShell
      folder={folder}
      calendarSrc={calendarSrc}
      driveFolderId={driveFolderId}
      visibleListLength={visibleList.length}
      countLabel={countLabel}
      stuckApprovedCount={stuckApprovedFiltered.length}
      rightPaneOpen={rightPaneOpen}
      shortcutsHelpOpen={shortcutsHelpOpen}
      cooldown={cooldown}
      toast={toast}
      mobileDetailOpen={mobileDetailOpen}
      onToggleRightPane={toggleRightPane}
      onOpenShortcutsHelp={() => setShortcutsHelpOpen(true)}
      onCloseShortcutsHelp={() => setShortcutsHelpOpen(false)}
      onForceResumeCooldown={fireForceResumeCooldown}
      onDismissToast={dismissToast}
      onMobileBack={() => setMobileDetailOpen(false)}
      listContent={
        <QueueList
          mode={mode}
          folder={folder}
          visibleList={visibleList}
          stuckApprovedFiltered={stuckApprovedFiltered}
          newCount={newCount}
          sortOrder={sortOrder}
          accountFilter={accountFilter}
          accounts={accounts}
          showAccount={showAccount}
          selected={selected}
          rowBusyId={rowBusyId}
          cooldown={cooldown}
          busyRetryId={busyRetryId}
          onSortNewest={() => setSortOrder('newest')}
          onSortOldest={() => setSortOrder('oldest')}
          onSelect={(id) => {
            setSelectedId(id);
            setMobileDetailOpen(true);
          }}
          onDismissNewDrafts={dismissNewDrafts}
          onAccountFilterChange={handleAccountFilterChange}
          onRetry={fireRetry}
          onClearLock={fireClearLock}
          onArchive={(draft) => fireInboxAction('archive', draft)}
          onDelete={(draft) => fireInboxAction('delete', draft)}
          onMarkRead={(draft) => fireInboxAction('mark-read', draft)}
          onSnooze={(draft, untilISO) => fireInboxAction('snooze', draft, { until: untilISO })}
        />
      }
      detailScrollBody={
        <QueueDetail
          mode={mode}
          selected={selected}
          busy={selected ? busyKindFor(selected.id) : null}
          isEditing={isEditing}
          redraftSeedBody={redraftSeedBody}
          redraftEnabled={redraftEnabled}
          rejectPopoverOpen={rejectPopoverOpen}
          onApprove={() => selected && fireAction('approve', selected)}
          onEditStart={() => setIsEditing(true)}
          onEditCancel={exitEdit}
          onEditSave={onEditSave}
          onRedraftApply={onRedraftApply}
          onReject={(payload) => selected && fireReject(payload, selected)}
          onReclassify={(category) => selected && fireReclassify(selected, category)}
          onRejectPopoverChange={setRejectPopoverOpen}
        />
      }
    />
  );
}
