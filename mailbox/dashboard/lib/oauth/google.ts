// dashboard/lib/oauth/google.ts
//
// MBOX-130 + MBOX-129 — shared Google OAuth + AES-256-GCM token storage.
//
// Introduced here as the peer module all Google integrations read (calendar
// pre-read, Google Tasks handoff, and the future Drive sync) per MBOX-130's
// instruction: STAQPRO-212 (Drive OAuth + token storage) had not landed when
// this picked up, so the OAuth + token storage is lifted here as the shared
// surface rather than duplicated per integration.
//
// Key-separation discipline: one mailbox.oauth_tokens row per `provider`
// ('google_calendar', 'google_tasks', 'google_drive'). Each row holds its OWN
// scope + encrypted refresh token; revoking one provider never touches another.
//
// Encryption: refresh tokens are stored AES-256-GCM-encrypted at rest. The key
// is MAILBOX_OAUTH_TOKEN_KEY (32-byte hex), separate from the
// MAILBOX_OAUTH_STATE_SECRET that the connect-flow state HMAC uses (key
// separation — a leak of one must not compromise the other).
//
// No googleapis SDK dependency — the appliance is dependency-light by
// constraint (CLAUDE.md). Token refresh hits Google's token endpoint directly
// over fetch; the same /api/chat-style minimal-wire approach the rest of the
// codebase uses for Ollama.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { getPool } from '@/lib/db';
import { getDefaultAccountId } from '@/lib/queries-accounts';

// MBOX-352 (MBOX-162 V2) — per-account OAuth routing. oauth_tokens is keyed
// (provider, account_id) since migration 033; every token read/write now scopes
// to a specific account. `accountId` is optional on each helper and falls back
// to the seeded default account, so the existing single-account callers
// (calendar pre-read, tasks handoff, the connect/callback routes) keep landing
// on the default mailbox's tokens exactly as before. A multi-mailbox appliance
// passes the draft's account so each inbox uses its own Google grant.
async function resolveAccountId(accountId?: number): Promise<number> {
  return accountId ?? (await getDefaultAccountId());
}

// The Google OAuth providers backed by mailbox.oauth_tokens. SoT for the
// provider key strings; the push/connect routes and the calendar/tasks/contacts
// modules read this set. 'google_drive' is reserved for STAQPRO-212 when it
// lands. 'google_contacts' (MBOX-398) backs the right-rail Contacts panel.
export const OAUTH_PROVIDERS = [
  'google_calendar',
  'google_tasks',
  'google_drive',
  'google_contacts',
  'google_gmail',
] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

// Per-provider scope. calendar.readonly is read-only (MBOX-130 — pre-read, not
// write). tasks is read/write (MBOX-129 pushes a task). drive scope deferred to
// STAQPRO-212. contacts.readonly is read-only (MBOX-398 — right-rail Contacts
// panel only reads the operator's own connections via the People API).
// gmail.readonly (MBOX-399 — per-account Sent-history voice backfill; read-only,
// no send). NOTE the key is `google_gmail`, NOT `gmail`: this is an
// oauth_tokens.provider grant key (the google_* family), deliberately distinct
// from the `gmail` MAIL TRANSPORT in lib/mail/providers/types.ts — that file's
// naming-discipline note warns against conflating the two namespaces.
export const PROVIDER_SCOPE: Record<OAuthProvider, string> = {
  google_calendar: 'https://www.googleapis.com/auth/calendar.readonly',
  google_tasks: 'https://www.googleapis.com/auth/tasks',
  google_drive: 'https://www.googleapis.com/auth/drive.readonly',
  google_contacts: 'https://www.googleapis.com/auth/contacts.readonly',
  google_gmail: 'https://www.googleapis.com/auth/gmail.readonly',
};

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// AES-256-GCM. 12-byte IV is the GCM standard; 16-byte auth tag. Packed string
// format: base64(iv).base64(tag).base64(ciphertext).
const IV_BYTES = 12;
const ALGO = 'aes-256-gcm';

function readKey(): Buffer {
  const hex = process.env.MAILBOX_OAUTH_TOKEN_KEY?.trim();
  if (!hex) {
    throw new Error('MAILBOX_OAUTH_TOKEN_KEY is not set — cannot encrypt/decrypt OAuth tokens');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(
      `MAILBOX_OAUTH_TOKEN_KEY must be 32 bytes (64 hex chars); got ${key.length} bytes`,
    );
  }
  return key;
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, readKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptToken(packed: string): string {
  const parts = packed.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed encrypted token (expected iv.tag.ciphertext)');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGO, readKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

// ── Connect-flow state HMAC (MAILBOX_OAUTH_STATE_SECRET) ─────────────────────
// Mirrors the Drive connector's state pattern (MBOX-130): the connect redirect
// carries an HMAC-signed state param so the callback can verify it originated
// from this appliance and pin which provider is being connected. Distinct
// secret from the token-encryption key (key separation).

function readStateSecret(): string {
  const s = process.env.MAILBOX_OAUTH_STATE_SECRET?.trim();
  if (!s) throw new Error('MAILBOX_OAUTH_STATE_SECRET is not set — cannot sign OAuth state');
  return s;
}

// MBOX-415 — state now also pins the account_id so a multi-account connect
// saves the token to the right account (oauth_tokens PK is (provider,
// account_id)). Payload: `provider:accountId:nonce`, HMAC-signed.
export function signState(provider: OAuthProvider, nonce: string, accountId: number): string {
  const payload = `${provider}:${accountId}:${nonce}`;
  const mac = createHmac('sha256', readStateSecret()).update(payload).digest('base64url');
  return `${payload}:${mac}`;
}

export function verifyState(
  state: string,
): { provider: OAuthProvider; accountId: number; nonce: string } | null {
  const idx = state.lastIndexOf(':');
  if (idx === -1) return null;
  const payload = state.slice(0, idx);
  const mac = state.slice(idx + 1);
  const expected = createHmac('sha256', readStateSecret()).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // payload = provider:accountId:nonce. provider + accountId have no ':'; nonce
  // is base64url (no ':') but rejoin defensively.
  const parts = payload.split(':');
  if (parts.length < 3) return null;
  const [provider, accountIdStr, ...rest] = parts;
  const nonce = rest.join(':');
  if (!(OAUTH_PROVIDERS as readonly string[]).includes(provider)) return null;
  const accountId = Number(accountIdStr);
  if (!Number.isInteger(accountId) || accountId <= 0) return null;
  return { provider: provider as OAuthProvider, accountId, nonce };
}

// ── Token storage (mailbox.oauth_tokens) ─────────────────────────────────────
// Raw pg.Pool (not Kysely) because oauth_tokens is a brand-new table (migration
// 031) and the kysely-codegen `DB` type does not include it until
// `npm run db:codegen` regenerates lib/db/schema.ts post-migration. Parameterized.

export interface OAuthTokenRow {
  provider: OAuthProvider;
  scope: string | null;
  account_email: string | null;
  last_fetched_at: string | null;
  connected_at: string;
  // Decrypted refresh token. Only populated by getRefreshToken (never returned
  // from the dashboard-facing status query — that uses getConnection).
  refresh_token?: string;
}

// Dashboard-facing connection status — never carries the token itself.
export interface OAuthConnection {
  provider: OAuthProvider;
  connected: boolean;
  scope: string | null;
  account_email: string | null;
  last_fetched_at: string | null;
  connected_at: string | null;
}

export async function getConnection(
  provider: OAuthProvider,
  accountId?: number,
): Promise<OAuthConnection> {
  const acct = await resolveAccountId(accountId);
  const pool = getPool();
  const r = await pool.query<{
    scope: string | null;
    account_email: string | null;
    last_fetched_at: string | null;
    connected_at: string | null;
    has_token: boolean;
  }>(
    `SELECT scope, account_email, last_fetched_at, connected_at,
            (refresh_token_enc IS NOT NULL) AS has_token
       FROM mailbox.oauth_tokens
      WHERE provider = $1 AND account_id = $2`,
    [provider, acct],
  );
  const row = r.rows[0];
  return {
    provider,
    connected: Boolean(row?.has_token),
    scope: row?.scope ?? null,
    account_email: row?.account_email ?? null,
    last_fetched_at: row?.last_fetched_at ?? null,
    connected_at: row?.connected_at ?? null,
  };
}

// Persist (upsert) a provider's refresh token + connect metadata. The plaintext
// refresh token is encrypted here; the caller never writes ciphertext directly.
export async function saveToken(input: {
  provider: OAuthProvider;
  refreshToken: string;
  scope: string;
  accountEmail: string | null;
  accountId?: number;
}): Promise<void> {
  const acct = await resolveAccountId(input.accountId);
  const enc = encryptToken(input.refreshToken);
  const pool = getPool();
  // MBOX-352 (MBOX-162 V2) — resolve account_id explicitly (default account when
  // the caller omits it). oauth_tokens PK is (provider, account_id) since
  // migration 033; the conflict target matches it so re-connecting a provider on
  // a given account overwrites that account's row, not another's.
  await pool.query(
    `INSERT INTO mailbox.oauth_tokens
       (provider, account_id, refresh_token_enc, scope, account_email, connected_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (provider, account_id) DO UPDATE
       SET refresh_token_enc = EXCLUDED.refresh_token_enc,
           scope = EXCLUDED.scope,
           account_email = EXCLUDED.account_email,
           updated_at = NOW()`,
    [input.provider, acct, enc, input.scope, input.accountEmail],
  );
}

// Disconnect: clear the row entirely (revokes by deletion). Returns whether a
// row was present. The route additionally best-effort revokes the grant at
// Google and clears any per-provider cache.
export async function deleteToken(
  provider: OAuthProvider,
  accountId?: number,
): Promise<{ deleted: boolean }> {
  const acct = await resolveAccountId(accountId);
  const pool = getPool();
  const r = await pool.query(
    'DELETE FROM mailbox.oauth_tokens WHERE provider = $1 AND account_id = $2',
    [provider, acct],
  );
  return { deleted: (r.rowCount ?? 0) > 0 };
}

// Stamp last_fetched_at after a successful data fetch (calendar events / tasks
// list). Best-effort — a stamp failure must not fail the fetch itself.
export async function markFetched(provider: OAuthProvider, accountId?: number): Promise<void> {
  const acct = await resolveAccountId(accountId);
  const pool = getPool();
  await pool.query(
    'UPDATE mailbox.oauth_tokens SET last_fetched_at = NOW(), updated_at = NOW() WHERE provider = $1 AND account_id = $2',
    [provider, acct],
  );
}

// Read + decrypt the stored refresh token. Returns null when the provider is
// not connected. Throws only on a decrypt failure (corrupt ciphertext / wrong
// key), which is a configuration error the caller should surface.
export async function getRefreshToken(
  provider: OAuthProvider,
  accountId?: number,
): Promise<string | null> {
  const acct = await resolveAccountId(accountId);
  const pool = getPool();
  const r = await pool.query<{ refresh_token_enc: string | null }>(
    'SELECT refresh_token_enc FROM mailbox.oauth_tokens WHERE provider = $1 AND account_id = $2',
    [provider, acct],
  );
  const enc = r.rows[0]?.refresh_token_enc;
  if (!enc) return null;
  return decryptToken(enc);
}

// ── Access-token exchange ────────────────────────────────────────────────────

export class OAuthTokenError extends Error {
  constructor(
    message: string,
    // 'not_connected' — no token row; 'auth' — Google rejected the refresh
    // (token revoked/expired, operator must reconnect); 'transient' — network
    // / 5xx (retryable).
    readonly kind: 'not_connected' | 'auth' | 'transient',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OAuthTokenError';
  }
}

function readClientCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new OAuthTokenError(
      'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not set',
      'not_connected',
    );
  }
  return { clientId, clientSecret };
}

// Redirect URI Google calls back after consent. Must be registered in the
// Google Cloud console for the OAuth client. Built from the dashboard's public
// base + the basePath-aware callback path (the dashboard is served under
// /dashboard — see lib/api.ts). MAILBOX_PUBLIC_BASE_URL is the appliance's
// https origin (e.g. https://mailbox.heronlabsinc.com).
function callbackUrl(): string {
  const base = process.env.MAILBOX_PUBLIC_BASE_URL?.trim();
  if (!base) {
    throw new OAuthTokenError('MAILBOX_PUBLIC_BASE_URL not set', 'not_connected');
  }
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  return `${base.replace(/\/$/, '')}${basePath}/api/oauth/google/callback`;
}

// Build the Google consent-screen URL for a provider. `access_type=offline` +
// `prompt=consent` force Google to return a refresh token (without consent,
// Google omits it on re-auth). The signed state pins the provider through the
// round-trip (verifyState on the callback).
export function buildConsentUrl(provider: OAuthProvider, nonce: string, accountId: number): string {
  const { clientId } = readClientCreds();
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', callbackUrl());
  url.searchParams.set('response_type', 'code');
  // openid+email so the callback can resolve the connected account email for
  // the settings UI, plus the provider's data scope.
  url.searchParams.set('scope', `openid email ${PROVIDER_SCOPE[provider]}`);
  url.searchParams.set('access_type', 'offline');
  // 'select_account' forces Google's account chooser so the operator can pick a
  // DIFFERENT Google identity per appliance account (MBOX-415 multi-account) —
  // without it Google silently reuses the already-signed-in account. 'consent'
  // still forces a refresh_token on every grant.
  url.searchParams.set('prompt', 'consent select_account');
  url.searchParams.set('state', signState(provider, nonce, accountId));
  return url.toString();
}

export interface CodeExchangeResult {
  refreshToken: string;
  scope: string;
  accountEmail: string | null;
}

// Exchange the one-time auth code from the consent callback for a refresh
// token, then resolve the connected account email. Throws OAuthTokenError on
// any failure (no refresh token returned, userinfo failure).
export async function exchangeCode(code: string): Promise<CodeExchangeResult> {
  const { clientId, clientSecret } = readClientCreds();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: callbackUrl(),
  });

  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new OAuthTokenError(
      `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      'transient',
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new OAuthTokenError(
      `code exchange failed (${res.status}): ${detail.slice(0, 200)}`,
      res.status >= 500 ? 'transient' : 'auth',
      res.status,
    );
  }
  const json = (await res.json().catch(() => null)) as {
    refresh_token?: string;
    access_token?: string;
    scope?: string;
  } | null;
  if (!json?.refresh_token) {
    // Google only returns a refresh token when access_type=offline +
    // prompt=consent AND this is a fresh grant. A missing one means the
    // operator already had a live grant; they must revoke + reconnect.
    throw new OAuthTokenError(
      'no refresh_token returned — revoke existing grant in Google account and reconnect',
      'auth',
      res.status,
    );
  }

  let accountEmail: string | null = null;
  if (json.access_token) {
    try {
      const ui = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${json.access_token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (ui.ok) {
        const uj = (await ui.json().catch(() => null)) as { email?: string } | null;
        accountEmail = uj?.email ?? null;
      }
    } catch {
      // Non-fatal — we still have the refresh token; email is cosmetic.
      accountEmail = null;
    }
  }

  return {
    refreshToken: json.refresh_token,
    scope: json.scope ?? '',
    accountEmail,
  };
}

// Best-effort revoke of a refresh token at Google (called on disconnect). A
// failure here is non-fatal — the local row is deleted regardless, which is
// what actually stops the appliance using the grant.
export async function revokeAtGoogle(refreshToken: string): Promise<void> {
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Swallow — local deletion is the source of truth for "disconnected."
  }
}

// Exchange the stored refresh token for a short-lived access token. Throws an
// OAuthTokenError with a typed `kind` so callers can branch: 'not_connected' /
// 'auth' → surface a reconnect prompt + fall back; 'transient' → retry/cooldown.
// TODO(MBOX-130 follow-up): cache access token (~55m TTL) to avoid dual RTT on
// the latency budget — refresh-then-data fetch is ~10s of the 30s local draft.
export async function getAccessToken(
  provider: OAuthProvider,
  timeoutMs = 5_000,
  accountId?: number,
): Promise<string> {
  const refresh = await getRefreshToken(provider, accountId);
  if (!refresh) {
    throw new OAuthTokenError(`${provider} not connected`, 'not_connected');
  }
  // Scope guard: verify the stored grant covers the provider's required scope
  // BEFORE we spend a token refresh + data fetch only to eat a confusing Google
  // 403. A grant can lack the scope if the operator connected an older version
  // or revoked partial consent. Surface as 'auth' → caller prompts a reconnect.
  const conn = await getConnection(provider, accountId);
  const required = PROVIDER_SCOPE[provider];
  if (!conn.scope?.split(/\s+/).includes(required)) {
    throw new OAuthTokenError(
      `${provider} grant is missing required scope ${required} — reconnect to re-consent`,
      'auth',
    );
  }
  const { clientId, clientSecret } = readClientCreds();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refresh,
    grant_type: 'refresh_token',
  });

  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new OAuthTokenError(
      `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      'transient',
    );
  }

  if (!res.ok) {
    // 400/401 from the token endpoint means the refresh token is bad (revoked /
    // expired) — the operator has to reconnect. 5xx is transient.
    const kind = res.status >= 500 ? 'transient' : 'auth';
    const detail = await res.text().catch(() => '');
    throw new OAuthTokenError(
      `token refresh failed (${res.status}): ${detail.slice(0, 200)}`,
      kind,
      res.status,
    );
  }

  const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!json?.access_token) {
    throw new OAuthTokenError('token endpoint returned no access_token', 'auth', res.status);
  }
  return json.access_token;
}
