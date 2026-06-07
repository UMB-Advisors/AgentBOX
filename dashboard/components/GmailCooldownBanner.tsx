'use client';

import { AlertOctagon, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { TimeAgo } from './TimeAgo';

// STAQPRO-331 #5 — operator-facing Gmail cooldown banner. Shown above the
// queue when system_state.gmail_rate_limit_until + the recommended +1h
// buffer is still in the future. Hidden otherwise.
//
// Per STAQPRO-271 forensics: every retry during the cooldown window
// EXTENDS the penalty. The banner messaging is intentionally directive
// ("Sending now will extend the cooldown") to prevent operator-driven
// re-aggravation while a 429 is active.
//
// MBOX-107 — adds an optional Force Resume button. The button uses the
// same 5s arm-then-confirm pattern as StuckApproved.tsx so a single
// accidental click can't clear the gate; the operator must explicitly
// re-click to confirm. Carries a directive warning that clearing the
// cooldown while Google's probation is still active will re-trigger the
// 429 and extend the penalty.

export interface CooldownState {
  is_active: boolean;
  until: string | null;
  set_at: string | null;
  recommended_safe_at: string | null;
}

interface Props {
  cooldown: CooldownState;
  // MBOX-107 — when provided, surfaces a Force Resume button gated
  // behind a 5s arm-then-confirm window. Omit to render the banner
  // read-only (e.g. for archive views).
  onForceResume?: () => void;
}

// MBOX-107 — arm-then-confirm window for Force Resume. Matches the
// constant in StuckApproved.tsx for muscle-memory consistency.
const ARM_WINDOW_MS = 5_000;

export function GmailCooldownBanner({ cooldown, onForceResume }: Props) {
  // Hooks must run unconditionally (rules-of-hooks). Declare before the
  // early-return below.
  const [armed, setArmed] = useState(false);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    },
    [],
  );

  if (!cooldown.is_active) return null;
  // After the recommended_safe_at moment we still might be in cooldown
  // (Google's hint can lie), but the banner has done its job once the
  // operator-side gate opens. UI is gated on is_active so we don't render
  // a stale banner forever.

  function handleForceResumeClick() {
    if (!onForceResume) return;
    if (armed) {
      if (armTimerRef.current) {
        clearTimeout(armTimerRef.current);
        armTimerRef.current = null;
      }
      setArmed(false);
      onForceResume();
      return;
    }
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    setArmed(true);
    armTimerRef.current = setTimeout(() => {
      setArmed(false);
      armTimerRef.current = null;
    }, ARM_WINDOW_MS);
  }

  return (
    <section
      role="alert"
      aria-live="polite"
      className="rounded-sm border border-accent-red/40 bg-accent-red/10 p-3"
    >
      <div className="flex items-start gap-2">
        <AlertOctagon size={18} className="mt-0.5 shrink-0 text-accent-red" aria-hidden />
        <div className="min-w-0 flex-1 font-sans text-sm">
          <p className="font-medium text-accent-red">Gmail send paused — rate-limited</p>
          <p className="mt-1 text-ink">
            <span className="font-mono text-xs text-ink-muted">Next safe send: </span>
            <SafeSendTime iso={cooldown.recommended_safe_at} />
            {cooldown.until && (
              <span className="ml-2 font-mono text-xs text-ink-dim">
                (Google's stated retry: <RawTime iso={cooldown.until} />)
              </span>
            )}
          </p>
          <p className="mt-1 font-sans text-xs text-accent-red/80">
            Sending now will <em>extend</em> the cooldown. Wait until the safe-send time before
            approving or retrying any drafts. The dashboard will block sends until then.
          </p>
          {cooldown.set_at && (
            <p className="mt-1 font-mono text-[11px] text-ink-dim">
              Detected <TimeAgo iso={cooldown.set_at} />
            </p>
          )}
          {onForceResume && (
            <div className="mt-2 border-t border-accent-red/20 pt-2">
              {armed && (
                <p className="mb-1.5 font-sans text-xs text-accent-red">
                  Clearing now while Google's probation is still active will re-trigger the 429 and
                  extend the penalty +15 min. Only proceed if Google's stated retry-after has
                  already passed. Click again within {ARM_WINDOW_MS / 1000}s to confirm.
                </p>
              )}
              <button
                type="button"
                onClick={handleForceResumeClick}
                aria-label="Force resume Gmail sends"
                className={`inline-flex items-center gap-1.5 rounded border px-3 py-1.5 font-sans text-xs transition-colors ${
                  armed
                    ? 'border-accent-red bg-accent-red/20 text-accent-red hover:bg-accent-red/30'
                    : 'border-accent-red/40 text-accent-red hover:bg-accent-red/10'
                }`}
              >
                <Zap size={12} />
                {armed ? 'Click again to confirm' : 'Force resume (override cooldown)'}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// Render the deadline as both wall-clock (so the operator can plan around
// it) and a short relative hint. SSR-safe — no `Date.now()` in render.
function SafeSendTime({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-ink-muted">unknown</span>;
  const d = new Date(iso);
  const wall = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <>
      <span className="font-mono font-medium text-ink">{wall}</span>{' '}
      <span className="text-ink-muted">
        (<TimeAgo iso={iso} />)
      </span>
    </>
  );
}

function RawTime({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <span className="font-mono">
      {d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </span>
  );
}
