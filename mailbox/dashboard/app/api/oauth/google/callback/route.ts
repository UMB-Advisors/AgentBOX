import { type NextRequest, NextResponse } from 'next/server';
import { apiUrl } from '@/lib/api';
import { parseQuery } from '@/lib/middleware/validate';
import { exchangeCode, saveToken, verifyState } from '@/lib/oauth/google';
import { oauthCallbackQuerySchema } from '@/lib/schemas/oauth';

// MBOX-130 + MBOX-129 — Google OAuth consent callback. Google redirects here
// with ?code=&state= (success) or ?error=&state= (operator declined). We verify
// the signed state (which pins the provider), exchange the code for a refresh
// token, persist it encrypted, and redirect the operator back to settings with
// a status query the page can surface as a toast.
//
// GET /api/oauth/google/callback?code=&state=  → 302 back to /settings/integrations

export const dynamic = 'force-dynamic';

function settingsRedirect(req: NextRequest, status: string): NextResponse {
  // Build an absolute URL. Prefer the configured public origin
  // (MAILBOX_PUBLIC_BASE_URL) — behind Caddy the request's own origin resolves
  // to the internal bind (http://0.0.0.0:3001), so redirecting there sends the
  // browser to https://0.0.0.0:3001 → ERR_SSL_PROTOCOL_ERROR (MBOX-402). Fall
  // back to the request origin only when the public base is unset.
  const base = process.env.MAILBOX_PUBLIC_BASE_URL?.trim() || req.nextUrl.origin;
  const url = new URL(apiUrl('/settings/integrations'), base);
  url.searchParams.set('oauth', status);
  return NextResponse.redirect(url);
}

// MBOX-399 — a per-account Gmail grant is initiated from /settings/accounts
// ("Learn voice" on a Gmail inbox), not the integrations page. Land the operator
// back THERE with ?gmail_connected=<id> so the Accounts page auto-runs the Sent
// backfill on return — making it a true one-click flow (consent is the detour).
function accountsGmailRedirect(req: NextRequest, accountId: number): NextResponse {
  const base = process.env.MAILBOX_PUBLIC_BASE_URL?.trim() || req.nextUrl.origin;
  const url = new URL(apiUrl('/settings/accounts'), base);
  url.searchParams.set('gmail_connected', String(accountId));
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const q = parseQuery(req, oauthCallbackQuerySchema);
  if (!q.ok) return q.response;
  const { code, state, error } = q.data;

  // Verify the signed state first — a bad/forged state is rejected before we
  // touch Google. This is what pins which provider the code belongs to.
  const verified = verifyState(state);
  if (!verified) {
    return settingsRedirect(req, 'invalid_state');
  }

  if (error || !code) {
    // Operator declined consent, or Google returned an error.
    return settingsRedirect(req, 'declined');
  }

  try {
    const exchanged = await exchangeCode(code);
    await saveToken({
      provider: verified.provider,
      refreshToken: exchanged.refreshToken,
      scope: exchanged.scope,
      accountEmail: exchanged.accountEmail,
      accountId: verified.accountId,
    });
    if (verified.provider === 'google_gmail') {
      return accountsGmailRedirect(req, verified.accountId);
    }
    return settingsRedirect(req, `connected_${verified.provider}`);
  } catch (err) {
    console.error('GET /api/oauth/google/callback exchange failed:', err);
    return settingsRedirect(req, 'exchange_failed');
  }
}
