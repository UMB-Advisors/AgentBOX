'use client';

import { Download, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '@/lib/api';

// MBOX-349 — operator-facing "Update now" trigger for the OTA execute path.
//
// Posts to /api/internal/ota/update-now, which runs pull → recreate → migrate
// → smoke → commit-or-rollback on the appliance host and writes a per-update
// audit row. The recreate tears down the running stack, so the action is
// gated behind the SAME 5s arm-then-confirm pattern as GmailCooldownBanner's
// Force Resume / StuckApproved's Retry — a single accidental click can't
// kick off an update.
//
// Self-contained (own fetch + state) so the server-rendered status page can
// drop it in without lifting state. Field validation of the real run is
// deferred to MBOX-350 — this wires the button + the call + the optimistic
// result surface only.

// Matches ARM_WINDOW_MS in GmailCooldownBanner.tsx / StuckApproved.tsx for
// muscle-memory consistency.
const ARM_WINDOW_MS = 5_000;

interface OtaOutcome {
  attempt_id: number;
  result: 'succeeded' | 'rolled_back' | 'failed';
  failed_step: string | null;
  detail: string;
}

interface Props {
  // Image digests from the MBOX-184 detection panel. Optional — a detection
  // miss still allows a manual trigger (the route records NULLs).
  fromDigest?: string | null;
  toDigest?: string | null;
}

export function OtaUpdateButton({ fromDigest = null, toDigest = null }: Props) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<OtaOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    },
    [],
  );

  async function runUpdate() {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await fetch(apiUrl('/api/internal/ota/update-now'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_digest: fromDigest, to_digest: toDigest }),
      });
      const body = (await res.json()) as OtaOutcome & { error?: string; message?: string };
      if (!res.ok && !body.result) {
        // Guard refusals (409 cooldown / in-flight) and 5xx without an outcome.
        setError(body.message ?? body.error ?? `Update failed (HTTP ${res.status})`);
        return;
      }
      setOutcome(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update request failed');
    } finally {
      setBusy(false);
    }
  }

  function handleClick() {
    if (busy) return;
    if (armed) {
      if (armTimerRef.current) {
        clearTimeout(armTimerRef.current);
        armTimerRef.current = null;
      }
      setArmed(false);
      void runUpdate();
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
    <div className="space-y-2">
      {armed && (
        <p className="font-sans text-xs text-accent-orange">
          This recreates the appliance stack (pull → migrate → smoke → rollback on failure) and
          briefly interrupts processing. Click again within {ARM_WINDOW_MS / 1000}s to confirm.
        </p>
      )}
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        aria-label="Run OTA update now"
        className={`inline-flex items-center gap-1.5 rounded border px-3 py-1.5 font-sans text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          armed
            ? 'border-accent-orange bg-accent-orange/20 text-accent-orange hover:bg-accent-orange/30'
            : 'border-border-subtle text-ink hover:bg-bg-panel'
        }`}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
        {busy
          ? 'Updating… (do not power off)'
          : armed
            ? 'Click again to confirm update'
            : 'Update now'}
      </button>
      {outcome && (
        <p
          className={`font-mono text-xs ${
            outcome.result === 'succeeded'
              ? 'text-accent-green'
              : outcome.result === 'rolled_back'
                ? 'text-accent-orange'
                : 'text-accent-red'
          }`}
          title={outcome.detail}
        >
          {outcome.result === 'succeeded'
            ? `Updated (attempt #${outcome.attempt_id})`
            : outcome.result === 'rolled_back'
              ? `Rolled back (attempt #${outcome.attempt_id}) — ${outcome.detail}`
              : `Update failed (attempt #${outcome.attempt_id}) — ${outcome.detail}`}
        </p>
      )}
      {error && <p className="font-mono text-xs text-accent-red">{error}</p>}
    </div>
  );
}
