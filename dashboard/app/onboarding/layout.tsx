import Link from 'next/link';
import type { ReactNode } from 'react';
import { getOnboarding } from '@/lib/queries-onboarding';

export const dynamic = 'force-dynamic';

// STAQPRO-152 — wizard chrome + live-gate enforcement.
//
// The same logic as /api/onboarding/live-gate (D-49): once stage='live',
// the wizard is shut. Operator can still visit during dogfood by setting
// MAILBOX_LIVE_GATE_BYPASS=1.
//
// We do NOT hard-redirect on live — keep it observable for support so the
// operator sees what state the appliance thinks it's in. If they did
// genuinely need to walk through onboarding again (e.g., after a re-flash),
// support flips the stage in Postgres directly. Real "reset onboarding" is
// out of scope for this scaffold.
//
// We do NOT pass currentSlug from the layout — Next.js layouts can't read
// the URL pathname directly without route segments + the App Router
// children-from-layout pattern, and the cleanest way to keep the indicator
// in sync is: each step page renders its own <StepShell slug="…"> which
// already wires up the StageIndicator.
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const bypass = process.env.MAILBOX_LIVE_GATE_BYPASS === '1';
  let stage = 'pending_admin';
  try {
    const row = await getOnboarding('default');
    stage = row?.stage ?? 'pending_admin';
  } catch (err) {
    // Fail open for the wizard — if Postgres is down the customer should
    // still see something rather than a blank page. Real /api/onboarding/
    // live-gate fails closed for drafting; the wizard renders so the
    // operator can see the appliance is alive.
    console.error('OnboardingLayout: failed to read onboarding stage:', err);
  }

  if (stage === 'live' && !bypass) {
    return (
      <main className="min-h-screen bg-bg-deep px-4 py-12 text-ink">
        <div className="mx-auto max-w-md rounded-2xl border border-border bg-bg-surface p-6 text-center">
          <h1 className="text-lg font-semibold">Onboarding already complete</h1>
          <p className="mt-2 text-sm text-ink-muted">
            This appliance is live. Open the queue to review pending drafts.
          </p>
          <Link
            href="/queue"
            className="mt-4 inline-block rounded-lg bg-accent-orange px-4 py-2 text-sm font-semibold text-white hover:bg-accent-orange/90"
          >
            Go to queue
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bg-deep px-4 py-8 text-ink">
      <div className="mb-6 text-center">
        <p className="text-xs uppercase tracking-widest text-ink-dim">MailBox One</p>
        <p className="text-sm text-ink-muted">Appliance setup</p>
      </div>
      {children}
    </main>
  );
}
