// dashboard/app/api/internal/google/access-token/route.ts
//
// MBOX-466 — Google ingestion unification, transport OPTION B (dashboard mints).
// MBOX-464 / addendum-01 (docs/n8n-credential-unification-prd.addendum-01.md) —
// re-point this minter at the SINGLE Google master.
//
// This route is the token authority for n8n's Gmail ingestion: it mints a
// short-lived Gmail access token for a given account. There are two stores it
// could read from, and the split between them WAS the MBOX-464 root cause:
//
//   PRIMARY (the single Google master): mailbox.oauth_tokens, provider
//   'google_gmail', keyed by account_id — the SAME encrypted store the dashboard
//   Google CONNECT writes (lib/oauth/google.ts:saveToken) and the dashboard's own
//   Calendar/Drive/Contacts surfaces read. We delegate to
//   lib/oauth/google.ts:getAccessToken, so the store the operator writes on
//   connect is exactly the store this minter reads. Client id/secret come from
//   env (GOOGLE_OAUTH_CLIENT_ID/SECRET), not a file.
//
//   FALLBACK (DEPRECATED): the mounted, read-only Hermes plaintext file store
//   (${HERMES_HOME}/google_accounts/<email>.json + google_client_secret.json,
//   written by hermes_cli/google_accounts.py). Kept ONLY so a box that connected
//   Google via Hermes (file present) but has no oauth_tokens grant yet does not
//   regress. This plaintext-on-disk store is slated for removal once every box
//   sources Gmail from the dashboard connect — do NOT build new dependencies on
//   it. See the addendum for the deprecation + optional one-time backfill.
//
// Mount (docker-compose mailbox-dashboard service, READ-ONLY) — fallback only:
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
// Contract (unchanged):
//   GET ?account_email=<email>
//     → 200 { access_token: string, expires_at: string }   # never the refresh_token
//     → 401 if the shared-secret header is missing/wrong (or env unset)
//     → 400 if account_email is missing/malformed
//     → 404 if the account is connected in NEITHER store
//     → 502 if the Google token refresh itself fails
//
// Per-account isolation (HARD requirement): the PRIMARY path resolves the
// requested email to exactly one account_id and reads only that account's grant.
// The FALLBACK reads ONLY the one file named by the validated email — it NEVER
// iterates the accounts directory — so account A's request can never surface
// account B's token in either store.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { getAccessToken, OAuthTokenError } from '@/lib/oauth/google';
import { resolveIngestAccountId } from '@/lib/queries-accounts';

export const dynamic = 'force-dynamic';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Google's standard access-token lifetime; used to surface an absolute expiry
// for both mint paths (the primary delegate returns only the token string).
const ACCESS_TOKEN_TTL_SECONDS = 3600;

// Container-side mount root for the DEPRECATED file fallback. Pinned by
// HERMES_STORE_DIR (compose sets it to /hermes-store); the default keeps the
// fallback working if the env is omitted.
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

// Discriminated result so the two mint paths compose without NextResponse
// plumbing leaking between them.
type MintResult =
  | { ok: true; access_token: string; expires_at: string }
  | { ok: false; status: number; error: string };

function expiresAt(): string {
  return new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
}

// ── PRIMARY: the single Google master (mailbox.oauth_tokens) ──────────────────
// Delegates to lib/oauth/google.ts:getAccessToken, which reads + decrypts the
// per-account 'google_gmail' refresh token from oauth_tokens and exchanges it for
// a short-lived access token (client creds from env). Returns a 404-status
// MintResult on 'not_connected' so the caller falls through to the deprecated
// file store; 'auth'/'transient' surface as 502 (a real grant problem the file
// fallback should not silently paper over unless it actually holds a token).
async function mintFromOAuthTokens(email: string): Promise<MintResult> {
  const resolved = await resolveIngestAccountId({ account_email: email });
  if (!resolved.ok) {
    // The email isn't a connected inbox account — not in this store. Let the
    // file fallback try (it's keyed by email, independent of the accounts table).
    return { ok: false, status: 404, error: resolved.reason };
  }
  try {
    const access_token = await getAccessToken('google_gmail', 5_000, resolved.account_id);
    return { ok: true, access_token, expires_at: expiresAt() };
  } catch (err) {
    if (err instanceof OAuthTokenError) {
      // not_connected → no google_gmail grant for this account → try fallback.
      // auth → grant revoked / missing scope; transient → network/5xx.
      const status = err.kind === 'not_connected' ? 404 : 502;
      return { ok: false, status, error: err.message };
    }
    return { ok: false, status: 500, error: 'oauth_tokens mint failed' };
  }
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

// ── FALLBACK (DEPRECATED): the plaintext Hermes file store ────────────────────
// Verbatim-preserved legacy behavior, factored into a helper. Reads ONLY the one
// file named by the validated email (no directory iteration) and refreshes the
// stored token against Google. Slated for removal — see the file header.
async function mintFromHermesFile(email: string): Promise<MintResult> {
  const base = storeDir();
  // Strict per-account read: ONE file, named by the validated email. No
  // directory iteration. The EMAIL_RE guard forbids '/' so the join can't
  // traverse out of accounts.
  const accountPath = path.join(base, 'accounts', `${email}.json`);

  let record: HermesAccountRecord;
  try {
    record = JSON.parse(await readFile(accountPath, 'utf8')) as HermesAccountRecord;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      // Account not connected in EITHER store.
      return { ok: false, status: 404, error: 'account not connected' };
    }
    return { ok: false, status: 500, error: 'account token file unreadable' };
  }

  if (!record.refresh_token) {
    return { ok: false, status: 500, error: 'account has no refresh_token' };
  }

  let secret: GoogleClientSecret;
  try {
    secret = JSON.parse(
      await readFile(path.join(base, 'client_secret.json'), 'utf8'),
    ) as GoogleClientSecret;
  } catch {
    return { ok: false, status: 500, error: 'client secret unavailable' };
  }
  const clientBlock = secret.web ?? secret.installed;
  if (!clientBlock?.client_id || !clientBlock.client_secret) {
    return { ok: false, status: 500, error: 'client secret malformed' };
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
    return {
      ok: false,
      status: 502,
      error: `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    return { ok: false, status: 502, error: `token refresh failed (${res.status}): ${detail}` };
  }

  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  if (!json?.access_token) {
    return { ok: false, status: 502, error: 'token endpoint returned no access_token' };
  }

  // expires_in is seconds-from-now; surface an absolute ISO expiry for the
  // caller (default to Google's standard 3600s if omitted).
  const expires_at = new Date(
    Date.now() + (json.expires_in ?? ACCESS_TOKEN_TTL_SECONDS) * 1000,
  ).toISOString();
  return { ok: true, access_token: json.access_token, expires_at };
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

  // PRIMARY: the single Google master (oauth_tokens). On a 404 (no google_gmail
  // grant for this account here), fall through to the deprecated file store so a
  // not-yet-migrated box doesn't regress. A 5xx from the primary is a real grant/
  // network failure — only let the file fallback override it if the file actually
  // serves a token; otherwise surface the primary's error.
  const primary = await mintFromOAuthTokens(email);
  if (primary.ok) {
    return NextResponse.json({ access_token: primary.access_token, expires_at: primary.expires_at });
  }

  const fallback = await mintFromHermesFile(email);
  if (fallback.ok) {
    return NextResponse.json({
      access_token: fallback.access_token,
      expires_at: fallback.expires_at,
    });
  }

  // Neither store served the token. If the primary failed for a hard reason
  // (auth/transient → 5xx) prefer that — it's the more actionable signal than the
  // file fallback's generic 404/500. Otherwise surface the fallback's status.
  const chosen = primary.status >= 500 ? primary : fallback;
  return NextResponse.json({ error: chosen.error }, { status: chosen.status });
}
