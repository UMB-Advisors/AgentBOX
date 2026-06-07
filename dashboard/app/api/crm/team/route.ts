import { type NextRequest, NextResponse } from 'next/server';
import { createTeamMember, listTeam, type TeamInput, type TeamKind } from '@/lib/crm/queries';

// AgentBOX CRM — team members (humans + agents). Caddy basic_auth gated.
// GET  /api/crm/team        → { team }
// POST /api/crm/team {...}   → { member }
export const dynamic = 'force-dynamic';

function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'Internal error';
}

function readTeamInput(body: Record<string, unknown>): TeamInput | null {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return null;
  const kind: TeamKind = body.kind === 'agent' ? 'agent' : 'human';
  const depRaw = body.department_id;
  const department_id =
    depRaw === null || depRaw === undefined || depRaw === '' ? null : Number(depRaw);
  return {
    name,
    kind,
    title: typeof body.title === 'string' ? body.title : '',
    department_id: Number.isFinite(department_id as number) ? (department_id as number) : null,
    email: typeof body.email === 'string' ? body.email : '',
    status: body.status === 'inactive' ? 'inactive' : 'active',
    notes: typeof body.notes === 'string' ? body.notes : '',
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ team: await listTeam() });
  } catch (error) {
    console.error('GET /api/crm/team failed:', error);
    return NextResponse.json({ error: msg(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const input = readTeamInput(body);
    if (!input) return NextResponse.json({ error: 'name required' }, { status: 400 });
    return NextResponse.json({ member: await createTeamMember(input) });
  } catch (error) {
    console.error('POST /api/crm/team failed:', error);
    return NextResponse.json({ error: msg(error) }, { status: 500 });
  }
}
