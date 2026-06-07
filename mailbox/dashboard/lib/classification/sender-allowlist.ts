// MBOX-370 — per-sender never-spam allowlist (the "reclassify automatically" rule).
//
// When the operator picks "reclassify automatically" for a sender on
// /classifications, a row is upserted into mailbox.sender_never_spam (email).
// This is NOT a force-to-category rule (that was MBOX-368, reverted by migration
// 043) — it only means "never let this sender be dropped as spam."
//
// The behaviour lives in normalize (the `neverSpam` PreclassContext flag): for an
// allowlisted sender the heuristic suppressions (noreply + self-loop) are skipped
// so the real category stands (operator-domain → internal, or the model's
// verdict), and a genuine model spam_marketing verdict is surfaced to `unknown`.
// This module only answers "is this sender allowlisted?":
//   1. app/api/internal/classification-normalize/route.ts (live n8n classify).
//   2. lib/queries-sender-allowlist.ts:reclassifySenderEmails passes neverSpam=true
//      by construction (the sender it's processing was just allowlisted).
//
// Exact-email match, normalized via extractAddress (same as the heuristic
// preclass). Kill switch SENDER_NEVER_SPAM_DISABLE=1.

import { getKysely } from '@/lib/db';
import { extractAddress } from './preclass';

function neverSpamEnabled(): boolean {
  return process.env.SENDER_NEVER_SPAM_DISABLE !== '1';
}

/**
 * Is this sender on the never-spam allowlist? Single indexed lookup on the
 * exact (lowercased) address. Fail-open: any DB error is swallowed and treated
 * as "not allowlisted" so a transient Postgres hiccup degrades to the normal
 * classify path rather than mis-surfacing.
 */
export async function isNeverSpamSender(rawFrom: string | undefined): Promise<boolean> {
  if (!neverSpamEnabled()) return false;

  const email = extractAddress(rawFrom);
  if (!email) return false;

  try {
    const row = await getKysely()
      .selectFrom('sender_never_spam')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();
    return Boolean(row);
  } catch (error) {
    console.error(`[never-spam] lookup failed for ${email} — failing open:`, error);
    return false;
  }
}
