import { type NextRequest, NextResponse } from 'next/server';
import { parseParams } from '@/lib/middleware/validate';
import { deleteToken, getConnection, getRefreshToken, revokeAtGoogle } from '@/lib/oauth/google';
import { oauthProviderParamSchema } from '@/lib/schemas/oauth';

// MBOX-130 + MBOX-129 — operator-facing Google OAuth connection status +
// disconnect (basic_auth gated by Caddy; not under /api/internal). One handler
// pair per provider via the [provider] segment.
//
// GET    /api/oauth/google/[provider]  → connection status (never the token)
// DELETE /api/oauth/google/[provider]  → revoke + clear the stored token

export const dynamic = 'force-dynamic';

// MBOX-415 — optional ?account_id= scopes the status/disconnect to a specific
// appliance account; absent → the helper layer falls back to the default.
function accountIdFromQuery(req: NextRequest): number | undefined {
  const raw = req.nextUrl.searchParams.get('account_id');
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { provider: string } },
): Promise<NextResponse> {
  const p = parseParams(params, oauthProviderParamSchema);
  if (!p.ok) return p.response;

  try {
    const conn = await getConnection(p.data.provider, accountIdFromQuery(req));
    return NextResponse.json(conn);
  } catch (error) {
    console.error(`GET /api/oauth/google/${params.provider} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

// Disconnect: best-effort revoke at Google, then delete the local row (the row
// deletion is the source of truth for "disconnected"). Idempotent — returns
// 200 with { deleted: false } when nothing was connected. The calendar cache is
// process-local and TTL-bounded (~30s); we don't reach into it here because the
// next fetch sees not_connected and returns an empty snapshot anyway.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { provider: string } },
): Promise<NextResponse> {
  const p = parseParams(params, oauthProviderParamSchema);
  if (!p.ok) return p.response;

  try {
    const accountId = accountIdFromQuery(req);
    // Pull the token first so we can revoke it at Google before deleting.
    const token = await getRefreshToken(p.data.provider, accountId).catch(() => null);
    if (token) await revokeAtGoogle(token);
    const result = await deleteToken(p.data.provider, accountId);
    return NextResponse.json({ deleted: result.deleted });
  } catch (error) {
    console.error(`DELETE /api/oauth/google/${params.provider} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
