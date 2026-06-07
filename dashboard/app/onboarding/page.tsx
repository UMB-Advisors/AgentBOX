import { redirect } from 'next/navigation';

// Wizard entry point — bounce to the first step. Server component.
export default function OnboardingIndexPage(): never {
  redirect('/onboarding/welcome');
}
