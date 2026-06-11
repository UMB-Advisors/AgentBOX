'use client';

import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { apiUrl } from '@/lib/api';
import type { Category } from '@/lib/classification/prompt';
import { type AccountRef, type DraftWithMessage, REJECT_REASON_LABELS } from '@/lib/types';
import type { ActionKind } from './ActionButtons';
import { AppShell } from './AppShell';
import { DraftCard } from './DraftCard';
import { DraftDetail } from './DraftDetail';
import { EmptyState } from './EmptyState';
import { type CooldownState, GmailCooldownBanner } from './GmailCooldownBanner';
import { NewDraftsBanner } from './NewDraftsBanner';
import {
  PANES_AUTOSAVE_ID,
  RESIZE_HANDLE_CLASS,
  STUCK_APPROVED_THRESHOLD_MS,
} from './queue/constants';
import { useKeyboardNav } from './queue/useKeyboardNav';
import { useQueuePolling } from './queue/useQueuePolling';
import { useRightPane } from './queue/useRightPane';
import { type FolderKey, type Mode, modeForFolder, type ToastMsg } from './queue/utils';
import type { RejectPayload } from './RejectPopover';
import { RightPane } from './RightPane';
import { ShortcutsHelp } from './ShortcutsHelp';
import { StuckApproved } from './StuckApproved';
import { Toast } from './Toast';

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

  // P3 — Apply a streamed redraft: open the inline editor seeded with the
  // rewrite for a final human pass (no auto-send; reuses the P2 edit/save path).
  function onRedraftApply(body: string) {
    setRedraftSeedBody(body);
    setIsEditing(true);
  }

  function exitEdit() {
    setIsEditing(false);
    setRedraftSeedBody(null);
  }
  const dismissNewDrafts = () => setNewCount(0);

  // STAQPRO-331 #1 — fireAction now takes an optional `body` so reject can
  // ship the structured `{ reason_code, free_text }` payload while approve
  // keeps its empty-body shape. Auto-advance + toast logic stays shared.
  async function fireAction(kind: 'approve' | 'reject', draft: DraftWithMessage, body?: object) {
    setBusy({ draftId: draft.id, kind });
    try {
      const res = await fetch(apiUrl(`/api/drafts/${draft.id}/${kind}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `${kind} failed (${res.status})`);
      setRemoved((s) => {
        const next = new Set(s);
        next.add(draft.id);
        return next;
      });
      // STAQPRO-148-followup (Delphi UX pass) — auto-advance to the next
      // draft so the operator can click Approve / Reject repeatedly (or
      // hold `a` once keyboard nav lands) and burn through high-confidence
      // drafts without re-selecting.
      //
      // Snapshot the visible list BEFORE the removal, find the actioned
      // draft's position, then pick the next entry in the post-removal
      // list. Falls back to the previous entry when actioning the last
      // draft, or null when the queue empties.
      const oldVisible = mode === 'active' ? drafts.filter((d) => !removed.has(d.id)) : drafts;
      const idx = oldVisible.findIndex((d) => d.id === draft.id);
      const newVisible = oldVisible.filter((_, i) => i !== idx);
      const next = newVisible[idx] ?? newVisible[idx - 1] ?? null;
      setSelectedId(next?.id ?? null);
      setToast({
        kind: 'success',
        text: kind === 'approve' ? 'Approved — sending' : 'Rejected',
      });
      fetchData(true);
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : `${kind} failed`,
      });
    } finally {
      setBusy(null);
    }
  }

  // MBOX-369 — per-row Gmail action. Keyed on the INBOX MESSAGE id
  // (draft.message.id), not draft.id — the routes live under
  // /api/inbox-messages/[id]/*. archive/delete/snooze remove the row from the
  // queue (optimistic + auto-advance, mirroring fireAction); mark-read keeps the
  // row and just clears the unread state locally. A soft `gmail_synced:false`
  // from the server (local applied, Gmail mirror failed) surfaces as a warning,
  // not an error — the row already left the queue.
  async function fireInboxAction(
    kind: 'archive' | 'delete' | 'mark-read' | 'snooze',
    draft: DraftWithMessage,
    body?: object,
  ) {
    setRowBusyId(draft.id);
    try {
      const res = await fetch(apiUrl(`/api/inbox-messages/${draft.message.id}/${kind}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `${kind} failed (${res.status})`);
      const syncWarn = data?.gmail_synced === false ? ' (Gmail sync pending)' : '';

      if (kind === 'mark-read') {
        setDrafts((list) =>
          list.map((d) =>
            d.id === draft.id ? { ...d, message: { ...d.message, is_read: true } } : d,
          ),
        );
        setToast({ kind: 'success', text: `Marked read${syncWarn}` });
      } else {
        // Optimistic remove + auto-advance — same snapshot dance as fireAction.
        const oldVisible = mode === 'active' ? drafts.filter((d) => !removed.has(d.id)) : drafts;
        const idx = oldVisible.findIndex((d) => d.id === draft.id);
        setRemoved((s) => {
          const next = new Set(s);
          next.add(draft.id);
          return next;
        });
        if (selectedId === draft.id) {
          const newVisible = oldVisible.filter((_, i) => i !== idx);
          const next = newVisible[idx] ?? newVisible[idx - 1] ?? null;
          setSelectedId(next?.id ?? null);
        }
        const label = kind === 'archive' ? 'Archived' : kind === 'delete' ? 'Deleted' : 'Snoozed';
        setToast({ kind: 'success', text: `${label}${syncWarn}` });
      }
      fetchData(true);
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : `${kind} failed`,
      });
    } finally {
      setRowBusyId(null);
    }
  }

  // STAQPRO-331 #9 — reject success path now surfaces an UNDO toast carrying
  // the reason label. Implemented inline (not via fireAction) so the toast
  // can hold a reference to the just-rejected draft id without racing the
  // auto-advance state update. Approve stays on fireAction with no UNDO —
  // approve fires a Gmail Reply at the n8n side and is not safely reversible
  // once the webhook returns.
  async function fireReject(payload: RejectPayload, draft: DraftWithMessage) {
    setBusy({ draftId: draft.id, kind: 'reject' });
    try {
      const res = await fetch(apiUrl(`/api/drafts/${draft.id}/reject`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `reject failed (${res.status})`);

      setRemoved((s) => {
        const next = new Set(s);
        next.add(draft.id);
        return next;
      });
      // Auto-advance to the next visible draft (matches fireAction).
      const oldVisible = mode === 'active' ? drafts.filter((d) => !removed.has(d.id)) : drafts;
      const idx = oldVisible.findIndex((d) => d.id === draft.id);
      const newVisible = oldVisible.filter((_, i) => i !== idx);
      const next = newVisible[idx] ?? newVisible[idx - 1] ?? null;
      setSelectedId(next?.id ?? null);

      const reasonLabel = REJECT_REASON_LABELS[payload.reason_code];
      setToast({
        kind: 'success',
        text: `Rejected · ${reasonLabel}`,
        durationMs: 5000,
        action: {
          label: 'Undo',
          onClick: () => fireUndoReject(draft.id),
        },
      });
      fetchData(true);
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : 'reject failed',
      });
    } finally {
      setBusy(null);
    }
  }

  // STAQPRO-331 #9 — undo a reject within the 5s toast window. Drops the
  // local `removed` mark so the draft reappears in visibleActive once
  // fetchData repopulates it. 409 = window expired or already-undone; surface
  // as an error toast and bail without local state surgery.
  async function fireUndoReject(draftId: number) {
    try {
      const res = await fetch(apiUrl(`/api/drafts/${draftId}/undo-reject`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setToast({
          kind: 'error',
          text: data?.error ?? `Undo failed (${res.status})`,
        });
        return;
      }
      setRemoved((s) => {
        const next = new Set(s);
        next.delete(draftId);
        return next;
      });
      setToast({ kind: 'success', text: 'Reject undone' });
      fetchData(true);
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Undo failed',
      });
    }
  }

  async function fireRetry(draft: DraftWithMessage) {
    setBusy({ draftId: draft.id, kind: 'retry' });
    try {
      const res = await fetch(apiUrl(`/api/drafts/${draft.id}/retry`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Retry failed (${res.status})`);
      setToast({ kind: 'success', text: 'Retry — sending' });
      fetchData(true);
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Retry failed',
      });
    } finally {
      setBusy(null);
    }
  }

  // STAQPRO-IDEM-2026-05-22 — clear the MailBOX-Send CAS lock so a retry
  // can proceed. Caller must have already verified in Gmail Sent that the
  // reply did NOT actually go out (StuckApproved gates the click behind a
  // verification checkbox). The route requires `verified_in_gmail_sent: true`
  // as an explicit body attestation; this handler always sends it.
  async function fireClearLock(draft: DraftWithMessage) {
    setBusy({ draftId: draft.id, kind: 'retry' });
    try {
      const res = await fetch(apiUrl(`/api/drafts/${draft.id}/clear-send-attempt`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verified_in_gmail_sent: true }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Clear lock failed (${res.status})`);
      setToast({ kind: 'success', text: 'Lock cleared — safe to retry' });
      fetchData(true);
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Clear lock failed',
      });
    } finally {
      setBusy(null);
    }
  }

  // MBOX-107 — operator-driven force-resume of the Gmail rate-limit
  // cooldown. Hits DELETE /api/system/gmail-cooldown which clears the
  // singleton row that the n8n MailBOX `Cooldown Active?` gate AND the
  // dashboard approve/retry transitions both consult. Optimistically
  // clears local cooldown state so the banner disappears before the
  // next poll catches up; the next fetchData() reconciles.
  //
  // The banner's confirm prompt already carries the +15-min penalty
  // warning, so by the time this handler fires the operator has
  // explicitly attested they verified the original Retry-After elapsed.
  async function fireForceResumeCooldown() {
    try {
      const res = await fetch(apiUrl('/api/system/gmail-cooldown'), {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? `Force resume failed (${res.status})`);
      }
      // Optimistic: clear local state so the banner hides immediately.
      // fetchData(true) below will reconcile with the server's view.
      setCooldown({
        is_active: false,
        until: null,
        set_at: null,
        recommended_safe_at: null,
      });
      setToast({
        kind: 'success',
        text: data?.cleared
          ? 'Gmail cooldown cleared — sends resumed'
          : 'No active cooldown to clear',
      });
      fetchData(true);
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Force resume failed',
      });
    }
  }

  // P2 — inline edit save. Targets the currently `selected` draft (the inline
  // editor lives in its detail pane) and persists via the existing edit route.
  // Re-throws on failure so InlineDraftEditor stays open with the operator's
  // changes intact and surfaces the error inline.
  async function onEditSave(body: string, subject: string | null) {
    if (!selected) return;
    setBusy({ draftId: selected.id, kind: 'edit' });
    try {
      const res = await fetch(apiUrl(`/api/drafts/${selected.id}/edit`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_body: body, draft_subject: subject }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Edit failed (${res.status})`);
      setIsEditing(false);
      setRedraftSeedBody(null);
      setToast({ kind: 'success', text: 'Saved' });
      fetchData(true);
    } catch (err) {
      setBusy(null);
      throw err;
    } finally {
      setBusy((b) => (b?.kind === 'edit' ? null : b));
    }
  }

  // MBOX-123 — operator classification override (relabel only). PATCHes the
  // new category, optimistically patches the selected draft's message
  // classification in local state for instant feedback, then re-syncs. Unlike
  // approve/reject this does NOT auto-advance or remove the draft — the
  // operator is correcting the label, not actioning the draft. Re-draft on
  // override is intentionally out of scope for v1 (STAQPRO-403 / MBOX-123).
  async function fireReclassify(draft: DraftWithMessage, category: Category) {
    // No-op if the category didn't change (the popover already guards this,
    // but belt-and-suspenders against a programmatic call).
    if (draft.message.classification === category) return;
    try {
      const res = await fetch(apiUrl(`/api/drafts/${draft.id}/classification`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `reclassify failed (${res.status})`);
      // Optimistic local patch so the pill updates without waiting for the
      // next poll. fetchData(true) below reconciles against the server.
      setDrafts((list) =>
        list.map((d) =>
          d.id === draft.id ? { ...d, message: { ...d.message, classification: category } } : d,
        ),
      );
      setToast({ kind: 'success', text: `Reclassified as ${category}` });
      fetchData(true);
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : 'reclassify failed',
      });
    }
  }

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

  // Folder-specific count label for the header chip. Each folder name
  // matches the rail entry so the operator gets matching language.
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

  // P1b (MBOX-162) — list + detail bodies extracted as shared fragments so the
  // desktop PanelGroup and the mobile single-pane layout render identical
  // children (no duplicated DraftCard / DraftDetail wiring). Each is dropped
  // into a `flex h-full flex-col` container by both layouts.
  const listContent = (
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
              handleAccountFilterChange(e.target.value ? Number(e.target.value) : undefined)
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
            onClick={() => setSortOrder('newest')}
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
            onClick={() => setSortOrder('oldest')}
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
            onRetry={fireRetry}
            onClearLock={fireClearLock}
            cooldownActive={cooldown.is_active}
            cooldownSafeAt={cooldown.recommended_safe_at}
          />
          <NewDraftsBanner count={newCount} onDismiss={dismissNewDrafts} />
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
                  onSelect={() => {
                    setSelectedId(draft.id);
                    setMobileDetailOpen(true);
                  }}
                  {...(mode === 'active'
                    ? {
                        actionsBusy: rowBusyId === draft.id,
                        onArchive: () => fireInboxAction('archive', draft),
                        onDelete: () => fireInboxAction('delete', draft),
                        onMarkRead: () => fireInboxAction('mark-read', draft),
                        onSnooze: (untilISO: string) =>
                          fireInboxAction('snooze', draft, { until: untilISO }),
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

  const detailScrollBody = selected ? (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
      <DraftDetail
        draft={selected}
        busy={busyKindFor(selected.id)}
        readOnly={mode === 'archive'}
        onApprove={() => fireAction('approve', selected)}
        isEditing={isEditing}
        seedBody={redraftSeedBody ?? undefined}
        onEditStart={() => setIsEditing(true)}
        onEditCancel={exitEdit}
        onEditSave={onEditSave}
        redraftEnabled={redraftEnabled}
        onRedraftApply={onRedraftApply}
        onReject={(payload) => fireReject(payload, selected)}
        onReclassify={(category) => fireReclassify(selected, category)}
        rejectPopoverOpen={rejectPopoverOpen}
        onRejectPopoverChange={setRejectPopoverOpen}
      />
    </div>
  ) : (
    <div className="flex flex-1 items-center justify-center text-sm text-ink-dim">
      No draft selected
    </div>
  );

  return (
    <AppShell active={{ kind: 'folder', folder }}>
      {/* Top bar — wordmark/AppNav moved into the left rail (Sidebar) per
          STAQPRO-382 Phase 2a. Folder-aware count + stuck count + shortcuts
          hint stay as page-local chrome. The inline Inbox/Sent FolderTab
          nav was retired in Phase 2a-2 — the rail handles folder switching. */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-panel px-4">
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-border bg-bg-deep px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-muted">
            {visibleList.length} {countLabel}
          </span>
          {folder === 'queue' && stuckApprovedFiltered.length > 0 && (
            <span className="rounded-full border border-accent-orange/40 bg-accent-orange/10 px-2 py-0.5 font-mono text-[11px] tabular-nums text-accent-orange">
              {stuckApprovedFiltered.length} stuck
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* P1b (MBOX-162) — toggle the collapsible right pane. Desktop-only:
              the 3-pane layout is hidden below md where review is single-pane. */}
          <button
            type="button"
            onClick={toggleRightPane}
            className="hidden items-center gap-1.5 rounded-sm border border-border bg-bg-deep px-2 py-0.5 font-mono text-[11px] text-ink-dim hover:text-ink md:flex"
            title={rightPaneOpen ? 'Hide Calendar/Drive pane' : 'Show Calendar/Drive pane'}
            aria-pressed={rightPaneOpen}
          >
            {rightPaneOpen ? (
              <PanelRightClose className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
            )}
            <span>pane</span>
          </button>
          {/* STAQPRO-331 #7 — discovery hint for the keyboard shortcut help.
              Clicking also opens the overlay so it's not exclusively keyboard. */}
          <button
            type="button"
            onClick={() => setShortcutsHelpOpen(true)}
            className="flex items-center gap-1.5 rounded-sm border border-border bg-bg-deep px-2 py-0.5 font-mono text-[11px] text-ink-dim hover:text-ink"
            title="Show keyboard shortcuts"
          >
            <kbd className="font-mono text-[11px]">?</kbd>
            <span>shortcuts</span>
          </button>
        </div>
      </header>

      {/* STAQPRO-331 #5 — system-wide Gmail cooldown banner. Spans the
          full width above both panes so the operator sees it whether
          they're in Inbox or Sent view. Self-hides when not active. */}
      {cooldown.is_active && (
        <div className="border-b border-border-subtle bg-bg-panel px-4 py-2">
          <GmailCooldownBanner cooldown={cooldown} onForceResume={fireForceResumeCooldown} />
        </div>
      )}

      {/* P1b (MBOX-162) — resizable 3-pane layout on desktop; single-pane
          toggle on mobile. Phone review is the product's core value, so the
          mobileDetailOpen show-one-pane behavior is preserved verbatim below
          md. List + detail bodies are shared fragments (listContent /
          detailScrollBody) so both layouts render identical children. */}
      {/* Desktop: list | detail | (collapsible right pane) */}
      <div className="hidden min-h-0 flex-1 md:flex">
        <PanelGroup
          direction="horizontal"
          autoSaveId={PANES_AUTOSAVE_ID}
          className="min-h-0 flex-1"
        >
          <Panel id="queue-list" order={1} defaultSize={32} minSize={20}>
            <aside className="flex h-full min-h-0 flex-col border-r border-border-subtle">
              {listContent}
            </aside>
          </Panel>
          <PanelResizeHandle className={RESIZE_HANDLE_CLASS}>
            <span className="absolute inset-y-0 -left-1 -right-1 z-10" />
          </PanelResizeHandle>
          <Panel id="queue-detail" order={2} defaultSize={43} minSize={30}>
            <section className="flex h-full min-w-0 flex-col bg-bg-deep">
              {detailScrollBody}
            </section>
          </Panel>
          {rightPaneOpen && (
            <>
              <PanelResizeHandle className={RESIZE_HANDLE_CLASS}>
                <span className="absolute inset-y-0 -left-1 -right-1 z-10" />
              </PanelResizeHandle>
              <Panel id="queue-right" order={3} defaultSize={25} minSize={18}>
                <RightPane
                  calendarSrc={calendarSrc}
                  driveFolderId={driveFolderId}
                  onClose={toggleRightPane}
                />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>

      {/* Mobile: single pane, list <-> detail toggled by mobileDetailOpen. */}
      <div className="flex min-h-0 flex-1 md:hidden">
        {!mobileDetailOpen ? (
          <aside className="flex w-full min-h-0 flex-col">{listContent}</aside>
        ) : (
          <section className="flex min-w-0 flex-1 flex-col bg-bg-deep">
            <div className="flex h-10 shrink-0 items-center border-b border-border-subtle px-3">
              <button
                type="button"
                onClick={() => setMobileDetailOpen(false)}
                className="font-mono text-xs text-ink-muted hover:text-ink"
              >
                ← Back to queue
              </button>
            </div>
            {detailScrollBody}
          </section>
        )}
      </div>

      {shortcutsHelpOpen && <ShortcutsHelp onClose={() => setShortcutsHelpOpen(false)} />}
      {toast && <Toast {...toast} onDismiss={dismissToast} />}
    </AppShell>
  );
}
