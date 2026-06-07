import { type NextRequest, NextResponse } from 'next/server';
import { createDepartment, listDepartments } from '@/lib/crm/queries';

// AgentBOX CRM — departments (belong to a business). Caddy basic_auth gated.
// GET  /api/crm/departments                  → { departments }
// POST /api/crm/departments {name,business_id?} → { department }
export const dynamic = 'force-dynamic';

function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'Internal error';
}

function toBusinessId(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ departments: await listDepartments() });
  } catch (error) {
    console.error('GET /api/crm/departments failed:', error);
    return NextResponse.json({ error: msg(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown;
      business_id?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
    const department = await createDepartment(name, toBusinessId(body.business_id));
    return NextResponse.json({ department });
  } catch (error) {
    console.error('POST /api/crm/departments failed:', error);
    return NextResponse.json({ error: msg(error) }, { status: 500 });
  }
}
