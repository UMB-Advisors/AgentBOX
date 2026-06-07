// STAQPRO-152 — Single source of truth for the onboarding wizard scaffold.
//
// The 6 wizard UX steps map onto the 6 DB stages in mailbox.onboarding.stage
// (CHECK constraint from migration 006). Two of the steps share their entry
// DB stage with the previous step (welcome+password both sit on
// `pending_admin`; profile+network-check both sit on `pending_email`) — those
// are UX-only sub-steps inside a DB stage and the advance route treats the
// no-op transitions explicitly rather than silently skipping the call.
//
// Both the wizard pages and the advance route import from here, so a future
// stage rename is one file.

import type { OnboardingStage } from '@/lib/types';

export interface WizardStep {
  readonly slug: WizardStepSlug;
  readonly title: string;
  readonly intent: string;
  readonly dbStage: OnboardingStage;
  readonly allowsBack: boolean;
}

export type WizardStepSlug =
  | 'welcome'
  | 'password'
  | 'profile'
  | 'network-check'
  | 'email-connect'
  | 'complete';

export const WIZARD_STEPS = [
  {
    slug: 'welcome',
    title: 'Welcome',
    intent: "We'll get your MailBox One appliance online and triaging email in about ten minutes.",
    dbStage: 'pending_admin',
    allowsBack: false,
  },
  {
    slug: 'password',
    title: 'Set admin password',
    intent: 'Pick the password the appliance will use to gate the dashboard and the n8n editor.',
    dbStage: 'pending_admin',
    allowsBack: true,
  },
  {
    slug: 'profile',
    title: 'Operator profile',
    intent: 'Tell us who is signing the email so drafts pick up your name, brand, and signoff.',
    dbStage: 'pending_email',
    allowsBack: true,
  },
  {
    slug: 'network-check',
    title: 'Network check',
    intent:
      "We'll verify the appliance can reach Gmail and the cloud drafter before you connect email.",
    dbStage: 'pending_email',
    allowsBack: true,
  },
  {
    slug: 'email-connect',
    title: 'Connect Gmail',
    intent: 'Authorize the appliance to read your inbox and send replies on your behalf.',
    dbStage: 'ingesting',
    allowsBack: true,
  },
  {
    slug: 'complete',
    title: "You're live",
    intent:
      'The appliance is now running. The first draft will hit the queue on the next 5-minute poll.',
    dbStage: 'live',
    allowsBack: false,
  },
] as const satisfies ReadonlyArray<WizardStep>;

export const WIZARD_SLUGS = WIZARD_STEPS.map((s) => s.slug) as ReadonlyArray<WizardStepSlug>;

export function dbStageForSlug(slug: WizardStepSlug): OnboardingStage {
  const step = WIZARD_STEPS.find((s) => s.slug === slug);
  if (!step) throw new Error(`Unknown wizard slug: ${slug}`);
  return step.dbStage;
}

export function nextSlug(slug: WizardStepSlug): WizardStepSlug | null {
  const i = WIZARD_STEPS.findIndex((s) => s.slug === slug);
  if (i === -1 || i === WIZARD_STEPS.length - 1) return null;
  return WIZARD_STEPS[i + 1].slug;
}

export function prevSlug(slug: WizardStepSlug): WizardStepSlug | null {
  const i = WIZARD_STEPS.findIndex((s) => s.slug === slug);
  if (i <= 0) return null;
  return WIZARD_STEPS[i - 1].slug;
}

export function stepForSlug(slug: WizardStepSlug): WizardStep {
  const step = WIZARD_STEPS.find((s) => s.slug === slug);
  if (!step) throw new Error(`Unknown wizard slug: ${slug}`);
  return step;
}

export interface AllowedTransition {
  readonly from: OnboardingStage;
  readonly to: OnboardingStage;
}

// Derived from WIZARD_STEPS: every adjacent pair (slug N → slug N+1) is an
// allowed transition expressed as (dbStage[N], dbStage[N+1]). Same-stage
// pairs (welcome→password, profile→network-check) appear as no-op
// transitions (e.g., pending_admin → pending_admin) — kept explicit so the
// route's check is a pure equality scan rather than a "is no-op" branch.
export const ALLOWED_TRANSITIONS: ReadonlyArray<AllowedTransition> = WIZARD_STEPS.slice(0, -1).map(
  (step, i) => ({ from: step.dbStage, to: WIZARD_STEPS[i + 1].dbStage }),
);

export function isAllowedTransition(from: OnboardingStage, to: OnboardingStage): boolean {
  return ALLOWED_TRANSITIONS.some((t) => t.from === from && t.to === to);
}
