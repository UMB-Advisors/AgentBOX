import { getOnboarding } from '@/lib/queries-onboarding';

// MBOX-132 — digest recipient resolution.
//
// Resolution chain (open question resolved per the issue's recommendation):
//   1. MAILBOX_OPERATOR_EMAIL env — the canonical single-operator address,
//      already forwarded into the dashboard container (docker-compose.yml,
//      STAQPRO-221). This is the intended source.
//   2. Persona fallback — when the env is unset, fall back to the connected
//      operator mailbox (mailbox.onboarding.email_address). That IS the
//      operator's own address (the box sends FROM and TO the same operator
//      account on the appliance-OAuth send path), so it's a safe default.
//
// Returns null when neither is available — the route turns that into a
// "misconfigured, can't send" decision rather than guessing a recipient.

export interface ResolvedRecipient {
  email: string;
  source: 'env' | 'persona';
}

export async function resolveDigestRecipient(
  env: Record<string, string | undefined> = process.env,
  customerKey = 'default',
): Promise<ResolvedRecipient | null> {
  const fromEnv = env.MAILBOX_OPERATOR_EMAIL?.trim();
  if (fromEnv) return { email: fromEnv, source: 'env' };

  const onboarding = await getOnboarding(customerKey);
  const fromPersona = onboarding?.email_address?.trim();
  if (fromPersona) return { email: fromPersona, source: 'persona' };

  return null;
}
