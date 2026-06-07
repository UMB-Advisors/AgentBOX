'use client';

import { useEffect, useRef, useState } from 'react';
import { REJECT_REASON_CODES, type RejectReasonCode } from '@/lib/types';

// STAQPRO-331 #1 — structured reject reasons. Order matches the radio list
// rendered below. Mirrored against the Postgres CHECK constraint in
// migration 023 via REJECT_REASON_CODES in lib/types.ts.
const REJECT_REASONS: { code: RejectReasonCode; label: string; hint: string }[] = [
  {
    code: 'wrong_tone',
    label: 'Wrong tone / not my voice',
    hint: 'persona — tone, formality, sign-off',
  },
  {
    code: 'factually_inaccurate',
    label: 'Factually inaccurate',
    hint: 'hallucinated detail or commitment',
  },
  {
    code: 'missing_context',
    label: 'Missing context',
    hint: 'should have known from prior threads',
  },
  {
    code: 'should_reply_myself',
    label: 'I should reply myself',
    hint: 'escalate — not draftable by model',
  },
  {
    code: 'dont_reply',
    label: "Don't reply at all",
    hint: 'spam / no-action — classifier miss',
  },
  { code: 'other', label: 'Other (please specify)', hint: '' },
];

export interface RejectPayload {
  reason_code: RejectReasonCode;
  free_text: string | null;
}

interface Props {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: RejectPayload) => void;
}

// Defensive: the rendered codes must match the canonical SoT or the popover
// gets out of sync with the DB CHECK. Stays a no-op at runtime when both
// arrays are in lockstep (the common case); fires once at module load if not.
if (REJECT_REASONS.length !== REJECT_REASON_CODES.length) {
  console.warn(
    `[RejectPopover] REJECT_REASONS (${REJECT_REASONS.length}) drifted from REJECT_REASON_CODES (${REJECT_REASON_CODES.length})`,
  );
}

export function RejectPopover({ open, busy, onClose, onSubmit }: Props) {
  const [reason, setReason] = useState<RejectReasonCode | null>(null);
  const [note, setNote] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);

  // Reset state every time the popover opens — operator should not see a
  // stale selection from a previous draft.
  useEffect(() => {
    if (open) {
      setReason(null);
      setNote('');
    }
  }, [open]);

  // Outside-click + Esc dismissal — mirrors the sandbox UX.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const trimmed = note.trim();
  const submitDisabled = busy || reason === null || (reason === 'other' && trimmed.length === 0);

  function submit() {
    if (reason === null) return;
    if (reason === 'other' && trimmed.length === 0) return;
    onSubmit({ reason_code: reason, free_text: trimmed.length > 0 ? trimmed : null });
  }

  return (
    <div
      ref={ref}
      className="absolute top-full right-0 z-20 mt-2 w-80 rounded-md border border-border-subtle bg-bg-panel p-3 shadow-xl"
      role="dialog"
      aria-label="Reject draft"
    >
      <div className="mb-2 font-sans text-[11px] font-medium uppercase tracking-wider text-ink-muted">
        Why reject this draft?
      </div>
      <div className="space-y-0.5">
        {REJECT_REASONS.map((r) => (
          <label
            key={r.code}
            className={`flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 transition-colors hover:bg-bg-deep ${
              reason === r.code ? 'bg-accent-red/10' : ''
            }`}
          >
            <input
              type="radio"
              name="reject-reason"
              value={r.code}
              checked={reason === r.code}
              onChange={() => setReason(r.code)}
              disabled={busy}
              className="mt-1 accent-accent-red"
            />
            <div className="min-w-0 flex-1">
              <div className="font-sans text-sm text-ink">{r.label}</div>
              {r.hint && <div className="font-sans text-[11px] text-ink-dim">{r.hint}</div>}
            </div>
          </label>
        ))}
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy}
        placeholder={
          reason === 'other' ? 'Tell us what was wrong (required)' : 'Additional context (optional)'
        }
        className="mt-3 w-full resize-none rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-sans text-sm text-ink placeholder:text-ink-dim focus:border-border focus:outline-hidden disabled:opacity-50"
        rows={2}
        maxLength={2000}
      />
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded-sm px-3 py-1.5 font-sans text-xs font-medium text-ink-muted hover:bg-bg-deep disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitDisabled}
          className="rounded-sm bg-accent-red px-3 py-1.5 font-sans text-xs font-semibold text-bg-deep transition-colors hover:bg-accent-red/90 disabled:cursor-not-allowed disabled:bg-accent-red/40"
        >
          {busy ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
    </div>
  );
}
