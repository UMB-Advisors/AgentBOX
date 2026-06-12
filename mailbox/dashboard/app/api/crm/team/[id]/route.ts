import { type NextRequest, NextResponse } from 'next/server';
import {
  deleteTeamMember,
  type TeamInput,
  type TeamKind,
  updateTeamMember,
} from '@/lib/crm/queries';

// PATCH  /api/crm/team/[id] {...partial} → { member } | 404
// DELETE /api/crm/team/[id]              → { deleted, id } | 404
export const dynamic = 'force-dynamic';

function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'Internal error';
}

function readPatch(body: Record<string, unknown>): Partial<TeamInput> {
  const patch: Partial<TeamInput> = {};
  if (typeof body.name === 'string') patch.name = body.name.trim();
  if (body.kind === 'agent' || body.kind === 'human') patch.kind = body.kind as TeamKind;
  if (typeof body.title === 'string') patch.title = body.title;
  if ('department_id' in body) {
    const d = body.department_id;
    patch.department_id = d === null || d === '' || d === undefined ? null : Number(d);
  }
  if ('reports_to' in body) {
    const r = body.reports_to;
    patch.reports_to = r === null || r === '' || r === undefined ? null : Number(r);
  }
  if (typeof body.email === 'string') patch.email = body.email;
  if (body.status === 'active' || body.status === 'inactive') patch.status = body.status;
  if (typeof body.notes === 'string') patch.notes = body.notes;
  return patch;
}

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const params = await props.params;
  const id = Number(params.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const member = await updateTeamMember(id, readPatch(body));
    if (!member) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    return NextResponse.json({ member });
  } catch (error) {
    console.error(`PATCH /api/crm/team/${id} failed:`, error);
    return NextResponse.json({ error: msg(error) }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  props: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const params = await props.params;
  const id = Number(params.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  try {
    const deleted = await deleteTeamMember(id);
    if (!deleted) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    return NextResponse.json({ deleted: true, id });
  } catch (error) {
    console.error(`DELETE /api/crm/team/${id} failed:`, error);
    return NextResponse.json({ error: msg(error) }, { status: 500 });
  }
}
