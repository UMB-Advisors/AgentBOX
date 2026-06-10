import type { OnboardingStep } from "@/lib/api";

/**
 * Frontend helpers for the first-run onboarding wizard (MBOX-471), ported from
 * the mailbox dashboard's ``lib/onboarding/wizard-stages.ts``. The step list and
 * stage set are SERVED by the backend (``GET /api/onboarding/state``) so the
 * frontend never forks the source of truth — these helpers operate on that
 * served data (slug ordering, Back/Next, and the same-stage no-op detection that
 * lets a UX-only sub-step navigate client-side without an advance call).
 */

export type WizardSlug =
  | "welcome"
  | "password"
  | "profile"
  | "network-check"
  | "email-connect"
  | "complete";

export function stepIndex(steps: OnboardingStep[], slug: string): number {
  return steps.findIndex((s) => s.slug === slug);
}

export function stepForSlug(
  steps: OnboardingStep[],
  slug: string,
): OnboardingStep | undefined {
  return steps.find((s) => s.slug === slug);
}

export function nextSlug(
  steps: OnboardingStep[],
  slug: string,
): string | null {
  const i = stepIndex(steps, slug);
  if (i === -1 || i >= steps.length - 1) return null;
  return steps[i + 1].slug;
}

export function prevSlug(
  steps: OnboardingStep[],
  slug: string,
): string | null {
  const i = stepIndex(steps, slug);
  if (i <= 0) return null;
  return steps[i - 1].slug;
}

/**
 * Whether moving from ``slug`` to the next step is a UX-only sub-step that
 * shares the same persisted stage (welcome→password, profile→network-check). In
 * that case the wizard navigates client-side WITHOUT calling the advance route
 * — exactly the mailbox StepNav behaviour (a stage→stage self-pair would read as
 * invalid_transition).
 */
export function isSameStageHop(
  steps: OnboardingStep[],
  slug: string,
): boolean {
  const i = stepIndex(steps, slug);
  if (i === -1 || i >= steps.length - 1) return false;
  return steps[i].stage === steps[i + 1].stage;
}
