'use client';

import { Check, Edit3, X } from 'lucide-react';
import { useState } from 'react';
import { type RejectPayload, RejectPopover } from './RejectPopover';

export type ActionKind = 'approve' | 'edit' | 'reject';

export function ActionButtons({
  busy,
  onApprove,
  onEdit,
  onReject,
  rejectPopoverOpen,
  onRejectPopoverChange,
}: {
  busy: ActionKind | null;
  onApprove: () => void;
  onEdit: () => void;
  // STAQPRO-331 #1 — reject now carries structured feedback. Parent fires
  // the actual API call; this component owns the popover trigger + state.
  onReject: (payload: RejectPayload) => void;
  // Optional controlled-popover hooks so the parent (QueueClient) can open
  // the popover via the `x` keyboard shortcut without reaching into the
  // button's DOM. Omit both for uncontrolled (mouse-only) behavior.
  rejectPopoverOpen?: boolean;
  onRejectPopoverChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = rejectPopoverOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (onRejectPopoverChange) onRejectPopoverChange(next);
    else setUncontrolledOpen(next);
  };
  const disabled = busy !== null;
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onApprove}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-sm bg-accent-orange px-4 py-2 font-sans text-sm font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check size={16} />
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button
          type="button"
          onClick={onEdit}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-sm border border-accent-blue/60 bg-accent-blue/10 px-3 py-2 font-sans text-sm text-accent-blue transition-colors hover:bg-accent-blue/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Edit3 size={16} />
          {busy === 'edit' ? 'Saving…' : 'Edit'}
        </button>
        <div className="relative ml-auto">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            disabled={disabled}
            aria-haspopup="dialog"
            aria-expanded={open}
            className={`inline-flex items-center gap-1.5 rounded border px-3 py-2 font-sans text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              open
                ? 'border-accent-red bg-accent-red/10 text-accent-red'
                : 'border-accent-red/40 text-accent-red/80 hover:border-accent-red/70 hover:text-accent-red'
            }`}
          >
            <X size={16} />
            {busy === 'reject' ? 'Rejecting…' : 'Reject'}
          </button>
          <RejectPopover
            open={open}
            busy={busy === 'reject'}
            onClose={() => setOpen(false)}
            onSubmit={(payload) => {
              onReject(payload);
              setOpen(false);
            }}
          />
        </div>
      </div>
      {/* Keyboard hint — hidden on mobile (no kbd shortcuts there). x not r
          for reject so Cmd+R refresh slips don't accidentally reject. */}
      <p className="mt-2 hidden font-mono text-[10px] text-ink-dim md:block">
        <kbd className="rounded-sm border border-border px-1">j/k</kbd> navigate ·{' '}
        <kbd className="rounded-sm border border-border px-1">a</kbd> approve ·{' '}
        <kbd className="rounded-sm border border-border px-1">e</kbd> edit ·{' '}
        <kbd className="rounded-sm border border-border px-1">x</kbd> reject
      </p>
    </div>
  );
}
