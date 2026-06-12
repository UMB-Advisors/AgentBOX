// dashboard/app/api/internal/google/access-token/route.ts
//
// MBOX-466 — Google ingestion unification, transport OPTION B (dashboard mints).
//
// The token authority is THIS container (mailbox-dashboard). It mints a
// short-lived Gmail access token by reading the MOUNTED, read-only Hermes
// source-of-truth store: the per-account token file written by Hermes'
// hermes_cli/google_accounts.py and the operator-supplied Google client secret.
// Hermes itself (host, :9119, loopback-bound) is NOT called — this route never
// reaches across to it; it only reads files Hermes wrote.
//
// Mount (docker-compose mailbox-dashboard service, READ-ONLY):
//   ${HERMES_HOME:-${HOME}/.hermes}/google_accounts          → /hermes-store/accounts:ro
//   ${HERMES_HOME:-${HOME}/.hermes}/google_client_secret.json → /hermes-store/client_secret.json:ro
//
// Caller: n8n's MailBOX parent "Get Gmail Token" httpRequest node, over the
// docker network at http://mailbox-dashboard:3001/dashboard/api/internal/google/access-token
// (NOT the public funnel — the Caddyfile returns 403 for this path on every
// public/LAN site block; only the container network reaches it).
//
// Auth: a single shared-secret gate. The request MUST carry header
// X-Hermes-Internal-Token equal to env HERMES_INTERNAL_TOKEN (constant-time
// compare). FAIL CLOSED — if HERMES_INTERNAL_TOKEN is unset, every request is
// 401, so a misprovisioned box can never mint tokens unauthenticated.
//
// Contract:
//   GET ?account_email=<email>
//     → 200 { access_token: string, expires_at: string }   # never the refresh_token
//     → 401 if the shared-secret header is missing/wrong (or env unset)
//     → 400 if account_email is missing/malformed
//     → 404 if /hermes-store/accounts/<email>.json is absent (account not connected)
//     → 502 if the Google token refresh itself fails
//
// Per-account isolation (HARD requirement): the route reads ONLY the one file
// for the requested (lowercased, validated) email. It NEVER iterates the
// accounts directory — account A's request can never surface account B's token.
//
// No googleapis SDK — the refresh is a plain POST to Google's token endpoint,
// mirroring lib/oauth/google.ts:getAccessToken (the appliance is dependency-light
// by constraint, root CLAUDE.md).

import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Container-side mount root. Pinned by HERMES_STORE_DIR (compose sets it to
// /hermes-store); the default keeps the route working if the env is omitted.
function storeDir(): string {
  return process.env.HERMES_STORE_DIR?.trim() || '/hermes-store';
}

// Same email shape Hermes' google_accounts.py enforces before it writes
// <email>.json (no '@'/whitespace/'/' in local or domain; one dot in domain).
// We re-validate here so a crafted account_email can never escape the accounts
// dir or name an arbitrary file.
const EMAIL_RE = /^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/;

// Constant-time shared-secret check. Fail closed when the env is unset so a
// box provisioned without HERMES_INTERNAL_TOKEN rejects every request rather
// than minting tokens unauthenticated.
function authorized(req: NextRequest): boolean {
  const expected = process.env.HERMES_INTERNAL_TOKEN;
  if (!expected) return false; // fail closed
  const presented = req.headers.get('x-hermes-internal-token') ?? '';
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// The on-disk per-account record Hermes writes (hermes_cli/google_accounts.py
// _token_record). We only need refresh_token + token_uri here; the other keys
// (token/expiry/scopes/client_id/client_secret) are present but the locked
// contract sources client_id/client_secret from client_secret.json, not the
// account file.
interface HermesAccountRecord {
  refresh_token?: string;
  token_uri?: string;
}

// The standard Google client-secret JSON: a "web" (or "installed") block with
// client_id/client_secret/token_uri.
interface GoogleClientSecret {
  web?: { client_id?: string; client_secret?: string; token_uri?: string };
  installed?: { client_id?: string; client_secret?: string; token_uri?: string };
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

  const base = storeDir();
  // Strict per-account read: ONE file, named by the validated email. No
  // directory iteration. path.join(base, 'accounts', `${email}.json`) — the
  // EMAIL_RE guard above forbids '/' so the join can't traverse out of accounts.
  const accountPath = path.join(base, 'accounts', `${email}.json`);

  let record: HermesAccountRecord;
  try {
    record = JSON.parse(await readFile(accountPath, 'utf8')) as HermesAccountRecord;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      // Account not connected in the dashboard's Google store yet.
      return NextResponse.json({ error: 'account not connected' }, { status: 404 });
    }
    return NextResponse.json({ error: 'account token file unreadable' }, { status: 500 });
  }

  if (!record.refresh_token) {
    return NextResponse.json({ error: 'account has no refresh_token' }, { status: 500 });
  }

  let secret: GoogleClientSecret;
  try {
    secret = JSON.parse(
      await readFile(path.join(base, 'client_secret.json'), 'utf8'),
    ) as GoogleClientSecret;
  } catch {
    return NextResponse.json({ error: 'client secret unavailable' }, { status: 500 });
  }
  const clientBlock = secret.web ?? secret.installed;
  if (!clientBlock?.client_id || !clientBlock.client_secret) {
    return NextResponse.json({ error: 'client secret malformed' }, { status: 500 });
  }

  // Refresh exactly as lib/oauth/google.ts:getAccessToken does — POST the stored
  // refresh token to Google's token endpoint (prefer the account/client-secret
  // token_uri, fall back to the canonical endpoint).
  const tokenUrl = record.token_uri || clientBlock.token_uri || GOOGLE_TOKEN_URL;
  const body = new URLSearchParams({
    client_id: clientBlock.client_id,
    client_secret: clientBlock.client_secret,
    refresh_token: record.refresh_token,
    grant_type: 'refresh_token',
  });

  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      // MUST bypass Next.js' Data Cache. Without this Next caches the token
      // response and serves a STALE access_token on every later call, so Gmail
      // then 401s "Invalid Credentials". Every request must do a LIVE refresh.
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    return NextResponse.json(
      { error: `token refresh failed (${res.status}): ${detail}` },
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

  // expires_in is seconds-from-now; surface an absolute ISO expiry for the
  // caller (default to Google's standard 3600s if omitted).
  const expiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString();

  // NEVER return the refresh_token.
  return NextResponse.json({ access_token: json.access_token, expires_at: expiresAt });
}
