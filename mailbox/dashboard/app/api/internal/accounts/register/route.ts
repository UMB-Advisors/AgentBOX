// dashboard/app/api/internal/accounts/register/route.ts
//
// MBOX-482 — the registration bridge between the HERMES-side operator-facing
// mail-account store (hermes_cli/mail_accounts.py, the 0600 file store the
// connect wizard + Settings write) and the PIPELINE-side mailbox.accounts table
// (+ provider_secret_enc) that n8n ingestion/send key everything on.
//
// MBOX-468/470 shipped the Hermes connect UX but explicitly DEFERRED the
// "credential push" — so a mailbox connected in Hermes never reached the
// pipeline. This route is that push. On a Hermes connect/re-auth, Hermes POSTs
// the account here; on disconnect, it POSTs to ../deregister. Hermes has no
// Postgres driver, so it calls this over the docker network with httpx (same
// shape as the Gmail access-token minter's caller).
//
// Single source of truth: the Hermes file store is the operator master;
// mailbox.accounts is the projection this route writes. The two NEVER share an
// encryption key — Hermes encrypts under HERMES_MAIL_SECRET_KEY, the pipeline
// reads provider_secret_enc under MAILBOX_OAUTH_TOKEN_KEY. So the bridge carries
// the secret as PLAINTEXT (over the internal docker network only) and this route
// re-encrypts it under the mailbox key via lib/oauth/google.ts:encryptToken. The
// plaintext is never persisted and never echoed back.
//
// Auth: identical shared-secret gate to the Google access-token minter —
// X-Hermes-Internal-Token must equal env HERMES_INTERNAL_TOKEN, constant-time
// compared via the shared lib/internal-auth.ts helper, FAIL CLOSED when the env
// is unset OR empty. Not Caddy-gated; reached only over the docker network (the
// Caddyfile 403s /api/internal/* on every public site block, same as the minter).
//
// Contract:
//   POST  ?  body { provider:'imap'|'microsoft', email, display_label?,
//                   provider_config?, secret }
//             → 200 { ok:true, account_id, adopted }   # adopted=fresh-box claim
//             → 401 bad/missing internal token (or env unset)
//             → 400 malformed body
//             → 500 encryption key unset/malformed, or DB failure
//   DELETE handled by the sibling ../deregister route.

import { type NextRequest, NextResponse } from 'next/server';
import { authorized } from '@/lib/internal-auth';
import { parseJson } from '@/lib/middleware/validate';
import { encryptToken } from '@/lib/oauth/google';
import { registerTransportAccount } from '@/lib/queries-accounts';
import { accountRegisterBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const parsed = await parseJson(req, accountRegisterBodySchema);
  if (!parsed.ok) return parsed.response;
  const { provider, email, display_label, provider_config, secret } = parsed.data;

  // Re-encrypt the transport secret under the MAILBOX key here — the plaintext
  // arrived only so this side could own the at-rest ciphertext the pipeline
  // reads. encryptToken throws if MAILBOX_OAUTH_TOKEN_KEY is unset/malformed,
  // which we surface as 500 (a misprovisioned box must NOT store plaintext).
  let secret_enc: string;
  try {
    secret_enc = encryptToken(secret);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'encryption failed' },
      { status: 500 },
    );
  }

  try {
    const { id, adopted } = await registerTransportAccount({
      provider,
      email,
      display_label: display_label ?? null,
      provider_config,
      secret_enc,
    });
    return NextResponse.json({ ok: true, account_id: id, adopted });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'account projection failed' },
      { status: 500 },
    );
  }
}
