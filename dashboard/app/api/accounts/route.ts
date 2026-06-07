import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { getConnection } from '@/lib/oauth/google';
import {
  AccountMutationError,
  createAccount,
  listAccounts,
  listAccountsDetailed,
} from '@/lib/queries-accounts';
import { accountCreateSchema } from '@/lib/schemas/accounts';

export const dynamic = 'force-dynamic';

// GET /api/accounts — MBOX-360 (MBOX-162 V3).
//
// Operator-facing (Caddy basic_auth gated, NOT /api/internal). Powers the
// queue's account filter/selector: the connected inboxes on this appliance.
// Single-account boxes return one row (the seeded default account); the
// selector renders inert until a 2nd inbox is connected.
//
// `?detail=1` returns the richer AccountDetail shape (provider + created_at)
// for the /settings/accounts management page; the bare form keeps the lean V3
// selector contract unchanged.
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams;
    // MBOX-415 — ?calendar=1 adds google_calendar connection status per account,
    // for the right-rail account picker + the Integrations account selector.
    if (sp.get('calendar') === '1') {
      const base = await listAccounts();
      const accounts = await Promise.all(
        base.map(async (a) => ({
          ...a,
          calendar_connected:
            (await getConnection('google_calendar', a.id).catch(() => null))?.connected ?? false,
        })),
      );
      return NextResponse.json({ accounts });
    }
    const detail = sp.get('detail') === '1';
    const accounts = detail ? await listAccountsDetailed() : await listAccounts();
    return NextResponse.json({ accounts });
  } catch (error) {
    console.error('GET /api/accounts failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

// POST /api/accounts — MBOX-366 (MBOX-162 V5). Connect a new inbox (registry
// row only — Gmail OAuth / n8n ingestion wiring stays operator work). 409 on a
// duplicate email_address.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseJson(request, accountCreateSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const account = await createAccount({
      email_address: parsed.data.email_address,
      display_label: parsed.data.display_label,
      provider: parsed.data.provider,
      provider_config: parsed.data.provider_config,
    });
    return NextResponse.json({ account }, { status: 201 });
  } catch (error) {
    if (error instanceof AccountMutationError && error.code === 'duplicate_email') {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 409 });
    }
    console.error('POST /api/accounts failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
