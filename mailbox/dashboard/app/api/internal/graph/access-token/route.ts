// dashboard/app/api/internal/graph/access-token/route.ts
//
// MBOX-482 P2 — Microsoft 365 / Graph ingestion + send, transport via
// token-as-data (the addendum-01 decision: HTTP providers mint per-request, no
// n8n credential). This route is the Graph token authority for n8n, the exact
// peer of the Gmail minter (app/api/internal/google/access-token): given an
// account_email, it mints a short-lived app-only Graph bearer for that mailbox.
//
// Unlike Gmail (OAuth refresh token), M365 here is APP-ONLY / client-credentials
// (NC-34, BYO Azure app reg): there is NO refresh token. We mint a fresh bearer
// per poll directly from the stored BYO Azure app credentials —
//   provider_config.{tenant_id, client_id}  (non-secret, accounts.provider_config)
//   provider_secret_enc                      (the client SECRET, AES-256-GCM)
// — exactly the credentials the connect probe (lib/mail/test-graph-connection.ts)
// validated end-to-end before mailbox.accounts was written by the MBOX-482
// registration bridge.
//
// Auth: the SAME fail-closed X-Hermes-Internal-Token gate as the Gmail minter
// (constant-time, 401 when the env is unset). Reached only over the docker
// network (Caddy 403s /api/internal/* publicly).
//
// Contract (mirrors the Gmail minter so the n8n node shape is identical):
//   GET ?account_email=<email>
//     → 200 { access_token: string, expires_at: string }   # never the secret
//     → 401 if the shared-secret header is missing/wrong (or env unset)
//     → 400 if account_email is missing/malformed
//     → 404 if the email isn't a connected M365 account
//     → 502 if Azure AD rejects the client-credentials grant
//     → 500 on decrypt / config error (misprovisioned box)
//
// Per-account isolation: resolves the email to exactly one account_id and reads
// only that account's provider_config + provider_secret_enc.

import { timingSafeEqual } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { decryptToken } from '@/lib/oauth/google';
import { resolveIngestAccountId } from '@/lib/queries-accounts';

export const dynamic = 'force-dynamic';

const TOKEN_HOST = 'https://login.microsoftonline.com';
// App-only Graph scope (.default = all statically-consented app permissions).
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
// Azure AD app-only tokens are ~3600s; surface an absolute expiry from the grant
// response's expires_in (fallback to this if omitted).
const DEFAULT_TTL_SECONDS = 3600;

// Same email shape the Gmail minter enforces (one '@', a dotted domain, no
// whitespace/slashes) so a crafted value can never escape resolution.
const EMAIL_RE = /^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/;

// Constant-time shared-secret check; fail closed when the env is unset (verbatim
// with the Gmail minter / the registration bridge).
function authorized(req: NextRequest): boolean {
  const expected = process.env.HERMES_INTERNAL_TOKEN;
  if (!expected) return false;
  const presented = req.headers.get('x-hermes-internal-token') ?? '';
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface MicrosoftAccountCreds {
  tenant_id: string;
  client_id: string;
  client_secret: string;
}

// Read + decrypt the stored M365 BYO Azure app credentials for one account.
// provider_config carries the non-secret tenant/client ids; provider_secret_enc
// is the AES-256-GCM client secret (written by the registration bridge under
// MAILBOX_OAUTH_TOKEN_KEY). Returns null when the account isn't a connected M365
// account (no row, wrong provider, or missing secret).
async function readCreds(accountId: number): Promise<MicrosoftAccountCreds | null> {
  const pool = getPool();
  const r = await pool.query<{
    provider: string;
    provider_config: { tenant_id?: string; client_id?: string } | null;
    provider_secret_enc: string | null;
  }>(
    `SELECT provider, provider_config, provider_secret_enc
       FROM mailbox.accounts
      WHERE id = $1`,
    [accountId],
  );
  const row = r.rows[0];
  if (!row || row.provider !== 'microsoft' || !row.provider_secret_enc) return null;
  const cfg = row.provider_config ?? {};
  if (!cfg.tenant_id || !cfg.client_id) return null;
  // decryptToken throws on a bad key / corrupt ciphertext — a config error the
  // caller surfaces as 500.
  const client_secret = decryptToken(row.provider_secret_enc);
  return { tenant_id: cfg.tenant_id, client_id: cfg.client_id, client_secret };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const raw = req.nextUrl.searchParams.get('account_email');
  const email = raw?.trim().toLowerCase() ?? '';
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'account_email missing or malformed' }, { status: 400 });
  }

  const resolved = await resolveIngestAccountId({ account_email: email });
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.reason }, { status: 404 });
  }

  let creds: MicrosoftAccountCreds | null;
  try {
    creds = await readCreds(resolved.account_id);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'credential decrypt failed' },
      { status: 500 },
    );
  }
  if (!creds) {
    return NextResponse.json({ error: 'account is not a connected M365 mailbox' }, { status: 404 });
  }

  // Client-credentials grant against the account's tenant. No refresh token —
  // this is minted fresh per call (per-poll), exactly like the probe did.
  const tokenUrl = `${TOKEN_HOST}/${encodeURIComponent(creds.tenant_id)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    grant_type: 'client_credentials',
    scope: GRAPH_SCOPE,
  });

  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      // Same Next.js Data-Cache bypass the Gmail minter needs — a cached bearer
      // would 401 Graph once expired. Every call mints live.
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    return NextResponse.json(
      { error: `graph token grant failed (${res.status}): ${detail}` },
      { status: 502 },
    );
  }

  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  if (!json?.access_token) {
    return NextResponse.json({ error: 'token endpoint returned no access_token' }, { status: 502 });
  }

  const expires_at = new Date(
    Date.now() + (json.expires_in ?? DEFAULT_TTL_SECONDS) * 1000,
  ).toISOString();
  return NextResponse.json({ access_token: json.access_token, expires_at });
}
