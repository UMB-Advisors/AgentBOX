import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import type { Onboarding, OnboardingStage } from '@/lib/types';

export async function getOnboarding(customerKey = 'default'): Promise<Onboarding | null> {
  const db = getKysely();
  const row = await db
    .selectFrom('onboarding')
    .selectAll()
    .where('customer_key', '=', customerKey)
    .executeTakeFirst();
  return (row as Onboarding | undefined) ?? null;
}

export async function setStage(
  stage: OnboardingStage,
  customerKey = 'default',
): Promise<Onboarding | null> {
  const db = getKysely();
  const row = await db
    .updateTable('onboarding')
    .set({
      stage,
      // Mirror the original CASE: only stamp lived_at when transitioning to 'live'.
      // ${stage} binds as a parameter; the comparison happens server-side.
      lived_at: sql<string | null>`CASE WHEN ${stage}::text = 'live' THEN NOW() ELSE lived_at END`,
    })
    .where('customer_key', '=', customerKey)
    .returningAll()
    .executeTakeFirst();
  return (row as Onboarding | undefined) ?? null;
}

export async function setAdmin(
  username: string,
  passwordHash: string,
  customerKey = 'default',
): Promise<Onboarding | null> {
  const db = getKysely();
  const row = await db
    .updateTable('onboarding')
    .set({
      admin_username: username,
      admin_password_hash: passwordHash,
      stage: 'pending_email',
    })
    .where('customer_key', '=', customerKey)
    .returningAll()
    .executeTakeFirst();
  return (row as Onboarding | undefined) ?? null;
}

export async function setEmail(email: string, customerKey = 'default'): Promise<Onboarding | null> {
  const db = getKysely();
  const row = await db
    .updateTable('onboarding')
    .set({
      email_address: email,
      stage: 'ingesting',
    })
    .where('customer_key', '=', customerKey)
    .returningAll()
    .executeTakeFirst();
  return (row as Onboarding | undefined) ?? null;
}

export async function isLive(customerKey = 'default'): Promise<boolean> {
  const row = await getOnboarding(customerKey);
  return row?.stage === 'live';
}
