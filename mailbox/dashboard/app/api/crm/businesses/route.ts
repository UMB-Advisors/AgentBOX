import { type NextRequest, NextResponse } from 'next/server';
import { createBusiness, listBusinesses } from '@/lib/crm/queries';

// AgentBOX CRM — businesses (the entities the operator runs). Caddy basic_auth gated.
// GET  /api/crm/businesses              → { businesses }
// POST /api/crm/businesses {name,desc?} → { business }
export const dynamic = 'force-dynamic';

function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'Internal error';
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ businesses: await listBusinesses() });
  } catch (error) {
    console.error('GET /api/crm/businesses failed:', error);
    return NextResponse.json({ error: msg(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown;
      description?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
    const description = typeof body.description === 'string' ? body.description : '';
    return NextResponse.json({ business: await createBusiness(name, description) });
  } catch (error) {
    console.error('POST /api/crm/businesses failed:', error);
    return NextResponse.json({ error: msg(error) }, { status: 500 });
  }
}
