// Queue action handlers — extracted verbatim from QueueClient.tsx.
// All fire* functions and inline-edit helpers live here; no state is owned.

import type { CooldownState } from '@/components/GmailCooldownBanner';
import { apiUrl } from '@/lib/api';
import type { Category } from '@/lib/classification/prompt';
import { type DraftWithMessage, REJECT_REASON_LABELS } from '@/lib/types';
import type { ActionKind } from '../ActionButtons';
import type { RejectPayload } from '../RejectPopover';
import type { Mode, ToastMsg } from './utils';

type Busy = { draftId: number; kind: ActionKind | 'retry' } | null;

interface UseQueueActionsParams {
  mode: Mode;
  drafts: DraftWithMessage[];
  removed: Set<number>;
  selected: DraftWithMessage | null;
  setBusy: (b: Busy | ((prev: Busy) => Busy)) => void;
  setRemoved: (updater: (s: Set<number>) => Set<number>) => void;
  setSelectedId: (id: number | null) => void;
  setRowBusyId: (id: number | null) => void;
  setDrafts: (updater: (list: DraftWithMessage[]) => DraftWithMessage[]) => void;
  setToast: (msg: ToastMsg) => void;
  setIsEditing: (v: boolean) => void;
  setRedraftSeedBody: (v: string | null) => void;
  setCooldown: (state: CooldownState) => void;
  fetchData: (silent: boolean) => void;
}

export function useQueueActions({
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
}: UseQueueActionsParams) {
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
        if (selected?.id === draft.id) {
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

  // STAQPRO-331 #9 — reject success path now surfaces an UNDO toast carrying
  // the reason label. Implemented separate from fireAction so the toast
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
  // operator is correcting the label, not actioning the draft.
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

  return {
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
  };
}
