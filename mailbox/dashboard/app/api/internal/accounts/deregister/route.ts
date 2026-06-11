// dashboard/app/api/internal/accounts/deregister/route.ts
//
// MBOX-482 — disconnect leg of the registration bridge (see ../register). When
// the operator removes a mailbox in Hermes (DELETE /api/accounts/mail/{id}),
// Hermes POSTs the account's email here so the pipeline projection
// (mailbox.accounts) revokes its transport too — MBOX-482 lifecycle: delete on
// disconnect. Keyed by stable email (account ids differ per box).
//
// Auth: same fail-closed X-Hermes-Internal-Token gate as ../register and the
// Gmail access-token minter. Carries no secret.
//
// Contract:
//   POST ? body { email }
//     → 200 { ok:true, action:'deleted'|'cleared', account_id }
//     → 200 { ok:false, reason:'not_found' }   # idempotent: nothing to revoke
//     → 401 bad/missing internal token (or env unset)
//     → 400 malformed body
//     → 500 DB failure
//
// 'cleared' (vs 'deleted') means the row survived (it was the default, or had
// mail/draft history) with its transport secret + provider_config stripped and
// provider reverted to 'gmail'. The per-account n8n IMAP credential teardown is
// the deploy tooling's job (bin/mbox-imap-cred-sync.sh --delete) — this route is
// the DB projection only.

import { type NextRequest, NextResponse } from 'next/server';
import { authorized } from '@/lib/internal-auth';
import { deregisterTransportAccount } from '@/lib/queries-accounts';
import { accountDeregisterBodySchema } from '@/lib/schemas/internal';
import { parseJson } from '@/lib/middleware/validate';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const parsed = await parseJson(req, accountDeregisterBodySchema);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await deregisterTransportAccount(parsed.data.email);
    // not_found is a 200 (idempotent disconnect — nothing to revoke), so a
    // ret/ double-delete from Hermes never 500s.
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'deregister failed' },
      { status: 500 },
    );
  }
}
