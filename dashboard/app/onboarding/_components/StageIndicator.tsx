'use client';

import { WIZARD_STEPS, type WizardStepSlug } from '@/lib/onboarding/wizard-stages';

// 6-step horizontal indicator. Stacked at sm breakpoint, horizontal at md+.
// Active step is bold + ringed; completed steps muted with a checkmark;
// future steps muted with a hollow circle.
export function StageIndicator({ currentSlug }: { currentSlug: WizardStepSlug }) {
  const currentIndex = WIZARD_STEPS.findIndex((s) => s.slug === currentSlug);

  return (
    <nav aria-label="Onboarding progress" className="mb-6 w-full">
      <ol className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        {WIZARD_STEPS.map((step, i) => {
          const status: 'completed' | 'active' | 'future' =
            i < currentIndex ? 'completed' : i === currentIndex ? 'active' : 'future';
          return (
            <li
              key={step.slug}
              className="flex flex-1 items-center gap-2"
              aria-current={status === 'active' ? 'step' : undefined}
            >
              <span
                className={[
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                  status === 'active'
                    ? 'border-accent-orange bg-accent-orange/10 text-accent-orange ring-2 ring-accent-orange/40'
                    : status === 'completed'
                      ? 'border-border bg-bg-panel text-ink-muted'
                      : 'border-border bg-transparent text-ink-dim',
                ].join(' ')}
              >
                {status === 'completed' ? '✓' : i + 1}
              </span>
              <span
                className={[
                  'truncate text-xs sm:text-sm',
                  status === 'active'
                    ? 'font-semibold text-ink'
                    : status === 'completed'
                      ? 'text-ink-muted'
                      : 'text-ink-dim',
                ].join(' ')}
              >
                {step.title}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
