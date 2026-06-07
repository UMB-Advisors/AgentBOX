'use client';

import { AlertTriangle, ChevronDown, KeyRound, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DraftWithMessage } from '@/lib/types';
import { TimeAgo } from './TimeAgo';

// STAQPRO-IDEM-2026-05-22 — when MailBOX-Send returns 409 because send_attempt_at
// is already set, transitions.ts persists the 409 body into drafts.error_message.
// Match the exact substring from the workflow's Respond Already Attempted node
// to switch the row UI into "lock held" mode with a verification-gated Clear
// Lock button.
const LOCK_HELD_MARKER = 'send_attempt_at already set';

// STAQPRO-202 — surfaces drafts stuck at status='approved' for >5 min.
// Two scenarios produce this state:
//   1. n8n crashed between Load Draft and Mark Sent — email may or may
//      not have left Gmail.
//   2. Gmail Reply succeeded but the Mark Sent Postgres UPDATE failed —
//      email definitely sent, status flip didn't land.
// Both look the same to the operator: row in `approved` past the 15s
// webhook timeout. The retry route now accepts `approved` (was failed-only),
// but firing it without verification can double-send. This component
// arms a 5-second confirmation window so the warning has a chance to
// register before the second click triggers.

const ARM_WINDOW_MS = 5_000;

export function StuckApproved({
  drafts,
  busyId,
  onRetry,
  onClearLock,
  cooldownActive = false,
  cooldownSafeAt = null,
}: {
  drafts: DraftWithMessage[];
  busyId: number | null;
  onRetry: (draft: DraftWithMessage) => void;
  // STAQPRO-IDEM-2026-05-22 — operator-driven clear of the MailBOX-Send CAS
  // lock (drafts.send_attempt_at). Only invoked from the "lock held" row UI
  // after the operator ticks the Gmail Sent verification checkbox. Optional
  // because not every consumer of StuckApproved needs the lock-clear path
  // (e.g. archive views); when omitted, the row falls back to the original
  // Retry-only behavior.
  onClearLock?: (draft: DraftWithMessage) => void;
  // STAQPRO-331 #5 — disable retry while system-wide Gmail cooldown is
  // active. The retry route also gates server-side (lib/transitions.ts),
  // but blocking the click prevents the dashboard 502+toast flicker and
  // reinforces the banner's "wait until safe-send" message.
  cooldownActive?: boolean;
  // STAQPRO-271 AC #5 — the system-wide recommended_safe_at timestamp
  // (raw 429 retry-after + the +1h STAQPRO-228 buffer). Surfaced inline
  // per stuck row when the cooldown is active so the operator sees
  // "safe to retry at HH:MM" rather than guessing. Null when no
  // cooldown is set.
  cooldownSafeAt?: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [armedId, setArmedId] = useState<number | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // STAQPRO-IDEM-2026-05-22 — per-row "I verified in Gmail Sent" checkbox state.
  // Gating the Clear Lock click behind explicit verification is the whole
  // point of the lock — without this checkbox we'd be one keystroke away from
  // re-introducing the 3-dupes class on a draft Gmail actually delivered.
  const [verifiedSentIds, setVerifiedSentIds] = useState<Set<number>>(() => new Set());
  function toggleVerified(id: number) {
    setVerifiedSentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(
    () => () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    },
    [],
  );

  if (drafts.length === 0) return null;

  function handleClick(draft: DraftWithMessage) {
    if (armedId === draft.id) {
      if (armTimerRef.current) {
        clearTimeout(armTimerRef.current);
        armTimerRef.current = null;
      }
      setArmedId(null);
      onRetry(draft);
      return;
    }
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    setArmedId(draft.id);
    armTimerRef.current = setTimeout(() => {
      setArmedId(null);
      armTimerRef.current = null;
    }, ARM_WINDOW_MS);
  }

  return (
    <section className="rounded-sm border border-accent-orange/40 bg-accent-orange/5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 p-3 font-sans text-sm font-medium text-accent-orange"
      >
        <AlertTriangle size={16} />
        <span>
          {drafts.length} stuck at approved
          <span className="ml-2 font-normal text-ink-muted">
            (n8n send may have hung or partially completed — verify before retrying)
          </span>
        </span>
        <ChevronDown
          size={16}
          className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <ul className="divide-y divide-accent-orange/20 border-t border-accent-orange/20">
          {drafts.map((draft) => {
            const isArmed = armedId === draft.id;
            const isBusy = busyId === draft.id;
            // STAQPRO-IDEM-2026-05-22 — error_message carries the 409 body
            // from MailBOX-Send's Respond Already Attempted node. Detect the
            // marker and switch into "lock held" mode for this row.
            const lockHeld =
              onClearLock != null && !!draft.error_message?.includes(LOCK_HELD_MARKER);
            const isVerifiedSent = verifiedSentIds.has(draft.id);
            return (
              <li key={draft.id} className="p-3">
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <p className="truncate font-mono text-xs text-ink-muted">
                    {draft.message.from_addr ?? 'unknown'}
                  </p>
                  <p className="font-mono text-xs text-ink-dim">
                    approved <TimeAgo iso={draft.updated_at} />
                  </p>
                </div>
                <p className="mb-2 truncate font-sans text-sm font-medium">
                  {draft.message.subject ?? '(no subject)'}
                </p>
                {/* STAQPRO-271 AC #4 — surface drafts.error_message (now
                    populated on send-webhook failure per lib/transitions.ts).
                    Operator no longer has to grep n8n execution_data to find
                    out why send failed. Truncated + tooltip'd because Gmail's
                    rate-limit string can be long. */}
                {draft.error_message && (
                  <p
                    className="mb-2 line-clamp-2 font-mono text-xs text-accent-red"
                    title={draft.error_message}
                  >
                    {draft.error_message}
                  </p>
                )}
                {/* STAQPRO-271 AC #5 — when a system-wide Gmail cooldown
                    is active, show the +1h-buffered safe-to-retry
                    timestamp inline. Pairs with the banner's "Gmail
                    rate-limited" headline so the operator can plan. */}
                {cooldownActive && cooldownSafeAt && (
                  <p className="mb-2 font-sans text-xs text-ink-muted">
                    Safe to retry after{' '}
                    <time dateTime={cooldownSafeAt} className="font-mono">
                      {new Date(cooldownSafeAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </time>
                  </p>
                )}
                {isArmed && !lockHeld && (
                  <p className="mb-2 font-sans text-xs text-accent-orange">
                    May have already sent — verify in your Gmail Sent folder before re-sending.
                    Click again within {ARM_WINDOW_MS / 1000}s to confirm.
                  </p>
                )}
                {/* STAQPRO-IDEM-2026-05-22 — lock-held branch. Replaces the
                    Retry button entirely (Retry would just 409 again until
                    the lock is cleared). Operator must tick the Gmail-Sent
                    verification checkbox before Clear Lock enables. */}
                {lockHeld && onClearLock ? (
                  <div className="space-y-2">
                    <p className="font-sans text-xs text-accent-orange">
                      The send lock is held. The reply may have already been delivered.{' '}
                      <strong>Open your Gmail Sent folder for this thread and verify.</strong>
                    </p>
                    <label className="flex items-start gap-2 font-sans text-xs text-ink-muted">
                      <input
                        type="checkbox"
                        checked={isVerifiedSent}
                        onChange={() => toggleVerified(draft.id)}
                        disabled={isBusy}
                        className="mt-0.5"
                      />
                      <span>
                        I verified in Gmail Sent — the reply did <strong>not</strong> go out.
                        Clearing the lock will allow another Retry to fire.
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => onClearLock(draft)}
                      disabled={!isVerifiedSent || isBusy}
                      className="inline-flex items-center gap-1.5 rounded border border-accent-orange/40 px-3 py-1.5 font-sans text-xs text-accent-orange transition-colors hover:bg-accent-orange/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <KeyRound size={12} />
                      {isBusy ? 'Clearing…' : 'Clear lock'}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleClick(draft)}
                    disabled={isBusy || cooldownActive}
                    title={
                      cooldownActive
                        ? 'Gmail rate-limited — retry will be blocked until the cooldown clears'
                        : undefined
                    }
                    className={`inline-flex items-center gap-1.5 rounded border px-3 py-1.5 font-sans text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      isArmed
                        ? 'border-accent-red bg-accent-red/10 text-accent-red hover:bg-accent-red/20'
                        : 'border-accent-orange/40 text-accent-orange hover:bg-accent-orange/10'
                    }`}
                  >
                    <RotateCcw size={12} />
                    {isBusy
                      ? 'Retrying…'
                      : cooldownActive
                        ? 'Retry (cooldown active)'
                        : isArmed
                          ? 'Click again to re-send'
                          : 'Retry (verify Gmail first)'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
