'use client';

import { Check, Pencil, Send, Wand2, X } from 'lucide-react';
import { useState } from 'react';
import type { Category } from '@/lib/classification/prompt';
import type { ActionItem, DraftWithMessage } from '@/lib/types';
import { ActionButtons, type ActionKind } from './ActionButtons';
import { ActionItemsPanel } from './ActionItemsPanel';
import { ClassificationOverride } from './ClassificationOverride';
import { CrossAccountPanel } from './CrossAccountPanel';
import { EditDiff } from './EditDiff';
import { EmailContext } from './EmailContext';
import { InlineDraftEditor } from './InlineDraftEditor';
import { RedraftPanel } from './RedraftPanel';
import type { RejectPayload } from './RejectPopover';
import { RoutingBadge } from './RoutingBadge';
import { SenderHistoryPanel } from './SenderHistoryPanel';
import { SourcesUsedPanel } from './SourcesUsedPanel';
import { TimeAgo } from './TimeAgo';

export function DraftDetail({
  draft,
  busy,
  readOnly = false,
  onApprove,
  isEditing = false,
  seedBody,
  onEditStart,
  onEditCancel,
  onEditSave,
  redraftEnabled = false,
  onRedraftApply,
  onReject,
  onReclassify,
  rejectPopoverOpen,
  onRejectPopoverChange,
}: {
  draft: DraftWithMessage;
  busy: ActionKind | null;
  readOnly?: boolean;
  onApprove: () => void;
  // P2 (MBOX-162) — inline edit replaces the EditModal overlay. `isEditing`
  // is controlled by QueueClient so the `e` keyboard shortcut can toggle it;
  // onEditStart enters edit mode (the ActionButtons "Edit"), onEditSave
  // persists via the edit route, onEditCancel exits without saving.
  isEditing?: boolean;
  // P3 (MBOX-162) — when set, the inline editor opens pre-seeded with this
  // body (a just-applied redraft) instead of the stored draft body.
  seedBody?: string;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditSave: (body: string, subject: string | null) => Promise<void>;
  // P3 (MBOX-162) — redraft-with-prompt. Flag-gated (MAILBOX_REDRAFT_ENABLED);
  // when off the button is hidden. onRedraftApply hands the streamed rewrite up
  // to QueueClient, which opens the inline editor seeded with it.
  redraftEnabled?: boolean;
  onRedraftApply: (body: string) => void;
  // STAQPRO-331 #1 — reject now carries structured feedback.
  onReject: (payload: RejectPayload) => void;
  // MBOX-123 — operator classification override (relabel only, no re-draft).
  onReclassify: (category: Category) => void;
  // Optional controlled-popover hooks from QueueClient (lets the 'x'
  // keyboard shortcut open the popover instead of firing reject directly).
  rejectPopoverOpen?: boolean;
  onRejectPopoverChange?: (open: boolean) => void;
}) {
  // P3 — redraft panel open state (local; no keyboard shortcut for v1).
  const [redraftOpen, setRedraftOpen] = useState(false);
  return (
    // STAQPRO-148-followup (Delphi UX pass) — restructured top-to-bottom so
    // operator never scrolls to reach the primary action: actions → draft →
    // inbound (collapsed). Old order pushed actions below the inbound body
    // which often overflowed the viewport.
    <article className="flex flex-col rounded-sm border border-border bg-bg-panel">
      <div className="border-b border-border px-5 py-3">
        {readOnly ? (
          <StatusBanner draft={draft} />
        ) : isEditing ? (
          // Approve/Reject are intentionally hidden while editing — the
          // operator saves (or cancels) the inline edit first, then the action
          // bar returns. Prevents approving the saved body mid-edit by mistake.
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-ink-dim">
            <Pencil size={14} aria-hidden />
            <span>Editing draft</span>
          </div>
        ) : (
          <ActionButtons
            busy={busy}
            onApprove={onApprove}
            onEdit={onEditStart}
            onReject={onReject}
            rejectPopoverOpen={rejectPopoverOpen}
            onRejectPopoverChange={onRejectPopoverChange}
          />
        )}
      </div>
      <div className="px-5 py-4">
        <p className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-ink-dim">
          <span>Draft reply</span>
          {/* MBOX-360 (MBOX-162 V3) — the owning mailbox this reply sends from.
              Lets the operator see the sending identity in a cross-account
              queue. Populated by the accounts join; absent on legacy rows. */}
          {draft.account && (
            <span
              className="rounded-sm border border-border bg-bg-deep px-1.5 py-0.5 normal-case tracking-normal text-ink-dim"
              title={draft.account.email_address}
            >
              via {draft.account.display_label || draft.account.email_address}
            </span>
          )}
          {draft.status === 'edited' && (
            <span className="rounded-full border border-accent-blue/40 bg-accent-blue/10 px-2 py-0.5 normal-case tracking-normal text-accent-blue">
              edited
            </span>
          )}
        </p>
        {isEditing && !readOnly ? (
          // key={draft.id} resets the editor's working copy when the operator
          // switches drafts (QueueClient also exits edit mode on selection
          // change, so this is belt-and-suspenders).
          <InlineDraftEditor
            key={draft.id}
            draft={draft}
            saving={busy === 'edit'}
            seedBody={seedBody}
            onSave={onEditSave}
            onCancel={onEditCancel}
          />
        ) : (
          <>
            {draft.draft_subject && (
              <p className="mb-3 font-mono text-sm text-ink-muted">
                <span className="text-ink-dim">Subject: </span>
                {draft.draft_subject}
              </p>
            )}
            <pre className="whitespace-pre-wrap font-serif text-base leading-relaxed text-ink">
              {draft.draft_body}
            </pre>
            {/* P3 (MBOX-162) — redraft-with-prompt. Flag-gated; hidden on
                read-only (archive) folders. Opens an inline panel; Apply hands
                the result to QueueClient, which opens the editor seeded with it. */}
            {redraftEnabled && !readOnly && !redraftOpen && (
              <button
                type="button"
                onClick={() => setRedraftOpen(true)}
                className="mt-3 flex items-center gap-1.5 rounded-sm border border-accent-blue/40 bg-accent-blue/5 px-2.5 py-1 font-sans text-sm text-accent-blue transition-colors hover:bg-accent-blue/10"
              >
                <Wand2 className="h-3.5 w-3.5" aria-hidden />
                Redraft with prompt
              </button>
            )}
            {redraftEnabled && !readOnly && redraftOpen && (
              <RedraftPanel
                key={draft.id}
                draftId={draft.id}
                currentBody={draft.draft_body}
                onApply={(body) => {
                  setRedraftOpen(false);
                  onRedraftApply(body);
                }}
                onClose={() => setRedraftOpen(false)}
              />
            )}
          </>
        )}
        {/* MBOX-131 — structured action items extracted from the inbound +
            draft. Inline add/edit/delete persists via POST
            /api/drafts/[id]/action-items. `key={draft.id}` remounts the panel
            on draft switch so its working copy resets without an effect.
            Read-only folders (sent/rejected archive) render the list but hide
            the mutation controls. */}
        <div className="mt-4">
          <ActionItemsPanel
            key={draft.id}
            draftId={draft.id}
            initialItems={(draft.action_items ?? []) as ActionItem[]}
            readOnly={readOnly}
          />
        </div>
        {/* STAQPRO-331 #3 — RoutingBadge surfaces local-vs-cloud + model +
            classifier confidence + a "low confidence fallback" tag when the
            cloud route was a safety-net rather than a category match. The
            old plain-text model line is dropped — the badge covers it. */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <RoutingBadge
            draftSource={draft.draft_source}
            model={draft.model}
            classification={draft.message.classification}
            confidence={draft.message.confidence}
          />
          {/* MBOX-123 — inline classification override. Relabel only (no
              re-draft): if the override changes intent, the operator hits
              Edit or Reject separately. Read-only (archive) folders show the
              category via RoutingBadge but don't expose the override control. */}
          {!readOnly && draft.message.classification && (
            <ClassificationOverride value={draft.message.classification} onChange={onReclassify} />
          )}
          {/* MBOX-460 — calendar-availability indicator for scheduling drafts.
              Reads the MBOX-130 flag set on the draft-prompt path. The boolean
              is binary, so the copy is deliberately "checked" vs "unavailable"
              rather than over-claiming real free/busy. Only shown on scheduling
              drafts (the flag is a no-op default elsewhere). */}
          {draft.message.classification === 'scheduling' &&
            (draft.scheduling_calendar_unavailable ? (
              <span
                className="rounded-sm border border-accent-orange/40 bg-accent-orange/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-accent-orange"
                title="Google Calendar could not be read when this draft was written (not connected, token expired, rate limited, or fetch failed) — proposed times may not reflect real availability."
              >
                Calendar unavailable
              </span>
            ) : (
              <span
                className="rounded-sm border border-accent-blue/40 bg-accent-blue/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-accent-blue"
                title="Google Calendar availability was checked when this scheduling draft was written."
              >
                Calendar checked
              </span>
            ))}
          {draft.input_tokens != null && draft.output_tokens != null && (
            <span className="font-mono text-xs text-ink-dim">
              {draft.input_tokens}↗ / {draft.output_tokens}↙ tokens
            </span>
          )}
        </div>
        {/* STAQPRO-331 #4 — show changes between the LLM-original body and
            the operator-edited current body. Only mounts when the draft is
            in 'edited' status AND original_draft_body was captured by
            STAQPRO-121 (NULL means this draft was never edited). EditDiff
            itself is also defensive — returns null on no-op diffs — so the
            outer guard is a fast-path, not a correctness gate. */}
        {draft.status === 'edited' && draft.original_draft_body && (
          <div className="mt-3">
            <EditDiff original={draft.original_draft_body} current={draft.draft_body} />
          </div>
        )}
        {/* STAQPRO-331 #2 — RAG attribution panel. Lazy-loads the
            rag_context_refs resolution on first expand. `key={draft.id}`
            forces a remount when the operator switches drafts so all local
            state (open / cached data) resets without an explicit effect. */}
        <div className="mt-3">
          <SourcesUsedPanel key={draft.id} draftId={draft.id} />
        </div>
        {/* STAQPRO-331 #6 — per-sender acceptance stats over 30 days. Same
            key={draft.id} remount trick so switching drafts resets the
            lazy-fetch state without an explicit effect. */}
        <div className="mt-2">
          <SenderHistoryPanel key={draft.id} draftId={draft.id} />
        </div>
        {/* MBOX-367 (MBOX-162 V4) — cross-account intelligence. Self-hiding:
            renders nothing unless this counterparty has reached another inbox
            on this appliance (inert on single-account boxes). key={draft.id}
            remounts the lazy fetch when the operator switches drafts. */}
        <div className="mt-2">
          <CrossAccountPanel key={draft.id} draftId={draft.id} />
        </div>
      </div>
      <div className="border-t border-border px-5 py-3">
        <EmailContext message={draft.message} history={draft.thread_history} />
      </div>
    </article>
  );
}

function StatusBanner({ draft }: { draft: DraftWithMessage }) {
  // Sent view replaces the action bar with a read-only status banner so the
  // operator can see WHAT happened and WHEN without re-firing it.
  switch (draft.status) {
    case 'sent':
      return (
        <Banner
          tone="green"
          icon={<Check size={16} />}
          label="Sent"
          timestamp={draft.sent_at ?? draft.updated_at}
        />
      );
    case 'approved':
      return (
        <Banner
          tone="orange"
          icon={<Send size={16} />}
          label="Approved — sending…"
          timestamp={draft.updated_at}
        />
      );
    case 'rejected':
      return (
        <Banner tone="red" icon={<X size={16} />} label="Rejected" timestamp={draft.updated_at} />
      );
    default:
      return <Banner tone="dim" icon={null} label={draft.status} timestamp={draft.updated_at} />;
  }
}

function Banner({
  tone,
  icon,
  label,
  timestamp,
}: {
  tone: 'green' | 'orange' | 'red' | 'dim';
  icon: React.ReactNode;
  label: string;
  timestamp: string | null;
}) {
  const palette = {
    green: 'border-accent-green/40 bg-accent-green/10 text-accent-green',
    orange: 'border-accent-orange/40 bg-accent-orange/10 text-accent-orange',
    red: 'border-accent-red/40 bg-accent-red/10 text-accent-red',
    dim: 'border-border bg-bg-deep text-ink-muted',
  }[tone];
  return (
    <div
      className={`flex items-center gap-2 rounded-sm border px-3 py-2 font-sans text-sm ${palette}`}
    >
      {icon}
      <span className="font-medium">{label}</span>
      {timestamp && (
        <span className="ml-auto font-mono text-xs opacity-75">
          <TimeAgo iso={timestamp} />
        </span>
      )}
    </div>
  );
}
