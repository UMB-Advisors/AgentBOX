// dashboard/lib/mail/test-graph-connection.ts
//
// MBOX-358 (P2) — onboarding test-connection probe for Microsoft 365 / Graph.
//
// Mirrors the IMAP test-connection's posture (lib/mail/test-connection.ts):
// DEPENDENCY-LIGHT BY DESIGN — no @azure/* / @microsoft/microsoft-graph-client
// SDK. The appliance does no other Graph I/O from the dashboard yet (operational
// send/poll is the DR-56 decision, the same gate IMAP send waits on), so pulling
// a full Graph SDK in just to answer "do these app credentials work?" isn't
// worth the deps. This is a PRE-SAVE SANITY CHECK using only global `fetch`.
//
// v1 consent model = BYO Azure app registration, APP-ONLY (client-credentials),
// per S-MP-3's kill→descope fallback and NC-34: the operator registers an app in
// their tenant, grants it the `Mail.ReadWrite` APPLICATION permission + admin
// consent, and hands us { tenant_id, client_id, client_secret, mailbox }. The
// probe proves two things:
//   1. the client credentials mint an app-only Graph token, and
//   2. that token can actually read the target mailbox's inbox.
// (Delegated / 3-legged consent is a future enhancement; app-only is the
//  zero-redirect path that fits the appliance's headless model.)

const TOKEN_HOST = 'https://login.microsoftonline.com';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const REQUEST_TIMEOUT_MS = 8000;

export interface GraphConnTarget {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  // The mailbox (UPN / email) the app credential will read on behalf of.
  mailbox: string;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export interface GraphTestResult {
  ok: boolean; // both legs ok
  token: ProbeResult; // can we mint an app-only token?
  mailbox: ProbeResult; // can that token read the inbox?
}

// ── Pure response classifiers (unit-tested; no I/O) ─────────────────────────

// Classify the OAuth2 client-credentials token response. Azure AD returns 200 +
// { access_token } on success; non-2xx + { error, error_description } on
// failure (invalid_client = bad secret/id; invalid_request / unauthorized_client
// = bad tenant or app config). We surface the AADSTS code when present — it's
// the single most useful thing for the operator to paste into a support search.
export function graphTokenVerdict(status: number, body: unknown): ProbeResult {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status >= 200 && status < 300 && typeof b.access_token === 'string' && b.access_token) {
    return { ok: true, detail: 'App-only token acquired' };
  }
  const err = typeof b.error === 'string' ? b.error : `HTTP ${status}`;
  const desc = typeof b.error_description === 'string' ? b.error_description : '';
  // First line of error_description carries the AADSTSxxxxx code.
  const firstLine = desc.split(/[\r\n]/, 1)[0]?.slice(0, 240) ?? '';
  if (err === 'invalid_client') {
    return { ok: false, detail: `Bad client secret or app id (${firstLine || 'invalid_client'})` };
  }
  if (err === 'unauthorized_client' || err === 'invalid_request') {
    return { ok: false, detail: `App registration / tenant problem (${firstLine || err})` };
  }
  return { ok: false, detail: `Token request failed: ${firstLine || err}` };
}

// Classify the GET /users/{mailbox}/mailFolders/inbox/messages probe. 200 = the
// app token can read the mailbox (success). The failure codes map to specific,
// actionable operator guidance — distinguishing "wrong mailbox" from "missing
// admin consent" is exactly what saves a support round-trip.
export function graphMailboxVerdict(status: number, body: unknown): ProbeResult {
  if (status >= 200 && status < 300) return { ok: true, detail: 'Inbox read OK' };

  const b = (body ?? {}) as Record<string, unknown>;
  const inner = (b.error ?? {}) as Record<string, unknown>;
  const code = typeof inner.code === 'string' ? inner.code : '';

  if (status === 401) {
    return { ok: false, detail: 'Graph rejected the token (401) — re-check app credentials' };
  }
  if (status === 403) {
    // The app authenticated but lacks Mail.ReadWrite application permission, or
    // admin consent was never granted — the single most common Graph BYO snag.
    return {
      ok: false,
      detail:
        'Forbidden (403) — grant the app the Mail.ReadWrite APPLICATION permission and admin consent',
    };
  }
  if (status === 404 || code === 'ErrorInvalidUser' || code === 'ResourceNotFound') {
    return { ok: false, detail: `Mailbox not found (${code || 404}) — check the email/UPN` };
  }
  if (status === 429)
    return { ok: false, detail: 'Graph throttled the probe (429) — retry shortly' };
  return { ok: false, detail: `Inbox read failed (${status}${code ? ` ${code}` : ''})` };
}

// ── fetch plumbing (exercised on-box; classifiers above are the tested core) ──

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonOrEmpty(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

async function probeToken(
  t: GraphConnTarget,
): Promise<{ result: ProbeResult; token: string | null }> {
  try {
    const res = await fetchWithTimeout(
      `${TOKEN_HOST}/${encodeURIComponent(t.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: t.clientId,
          client_secret: t.clientSecret,
          grant_type: 'client_credentials',
          scope: GRAPH_SCOPE,
        }).toString(),
      },
    );
    const body = (await jsonOrEmpty(res)) as Record<string, unknown>;
    const result = graphTokenVerdict(res.status, body);
    const token = result.ok && typeof body.access_token === 'string' ? body.access_token : null;
    return { result, token };
  } catch (e) {
    return {
      result: { ok: false, detail: `Token endpoint unreachable: ${errText(e)}` },
      token: null,
    };
  }
}

async function probeMailbox(t: GraphConnTarget, token: string): Promise<ProbeResult> {
  try {
    const url = `${GRAPH_BASE}/users/${encodeURIComponent(t.mailbox)}/mailFolders/inbox/messages?$top=1&$select=id`;
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    return graphMailboxVerdict(res.status, await jsonOrEmpty(res));
  } catch (e) {
    return { ok: false, detail: `Graph unreachable: ${errText(e)}` };
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Validate BYO Azure app credentials end-to-end: mint an app-only token, then
// read the target inbox with it. Never throws — failures come back as ok:false +
// a detail string safe to show the operator (the client secret is never echoed).
export async function testGraphConnection(t: GraphConnTarget): Promise<GraphTestResult> {
  const { result: token, token: accessToken } = await probeToken(t);
  if (!token.ok || !accessToken) {
    return {
      ok: false,
      token,
      mailbox: { ok: false, detail: 'Skipped — token acquisition failed' },
    };
  }
  const mailbox = await probeMailbox(t, accessToken);
  return { ok: token.ok && mailbox.ok, token, mailbox };
}
