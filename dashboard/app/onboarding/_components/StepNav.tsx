'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiUrl } from '@/lib/api';
import {
  dbStageForSlug,
  nextSlug,
  prevSlug,
  stepForSlug,
  type WizardStepSlug,
} from '@/lib/onboarding/wizard-stages';

interface StepNavProps {
  slug: WizardStepSlug;
}

// Wizard navigation footer. Next click flips the DB stage via
// /api/internal/onboarding/advance unless the next step shares the same DB
// stage (welcome→password, profile→network-check) — in that case we
// router.push directly with no API call.
//
// On error, render an inline banner. No auto-retry; the operator decides.
export function StepNav({ slug }: StepNavProps) {
  const router = useRouter();
  const step = stepForSlug(slug);
  const next = nextSlug(slug);
  const prev = prevSlug(slug);
  const isLast = next === null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdvance() {
    setError(null);
    const from = dbStageForSlug(slug);
    // The Finish button on /complete advances DB to 'live' and lands on the
    // queue. For all other steps we go to the next wizard slug.
    const targetSlug = next ?? 'complete';
    const to = dbStageForSlug(targetSlug);
    const landing = isLast ? '/queue' : `/onboarding/${targetSlug}`;

    // Same-DB-stage UX-only sub-step: skip the API call (no transition row
    // exists for stage→stage in ALLOWED_TRANSITIONS, so the route would 409
    // it as invalid_transition).
    if (from === to && !isLast) {
      router.push(landing);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/internal/onboarding/advance'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from, to, customer_key: 'default' }),
      });

      if (res.status === 200) {
        router.push(landing);
        return;
      }

      const payload = await res.json().catch(() => ({}));
      const message =
        typeof payload?.error === 'string' ? payload.error : `unexpected status ${res.status}`;
      setError(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setBusy(false);
    }
  }

  function handleBack() {
    if (!prev) return;
    router.push(`/onboarding/${prev}`);
  }

  return (
    <div className="mt-6 flex flex-col gap-3">
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-accent-red/40 bg-accent-red/10 px-4 py-2 text-sm text-accent-red"
        >
          <span className="font-mono text-xs">{error}</span>
        </div>
      ) : null}
      <div className="flex items-center justify-between">
        {step.allowsBack && prev ? (
          <button
            type="button"
            onClick={handleBack}
            disabled={busy}
            className="rounded-lg border border-border px-4 py-2 text-sm text-ink-muted hover:bg-bg-panel disabled:opacity-50"
          >
            Back
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={handleAdvance}
          disabled={busy}
          className="rounded-lg bg-accent-orange px-5 py-2 text-sm font-semibold text-white hover:bg-accent-orange/90 disabled:opacity-50"
        >
          {busy ? 'Saving…' : isLast ? 'Finish' : 'Next'}
        </button>
      </div>
    </div>
  );
}
