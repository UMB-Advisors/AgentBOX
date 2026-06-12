import { type NextRequest, NextResponse } from 'next/server';
import { deleteDepartment, updateDepartment } from '@/lib/crm/queries';

// PATCH  /api/crm/departments/[id] {name?,business_id?} → { department } | 404
// DELETE /api/crm/departments/[id]                      → { deleted, id } | 404
export const dynamic = 'force-dynamic';

function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'Internal error';
}

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const params = await props.params;
  const id = Number(params.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  try {
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown;
      business_id?: unknown;
    };
    const patch: { name?: string; business_id?: number | null } = {};
    if (typeof body.name === 'string') patch.name = body.name.trim();
    if ('business_id' in body) {
      const b = body.business_id;
      patch.business_id = b == null || b === '' ? null : Number(b);
    }
    const department = await updateDepartment(id, patch);
    if (!department) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    return NextResponse.json({ department });
  } catch (error) {
    console.error(`PATCH /api/crm/departments/${id} failed:`, error);
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
    const deleted = await deleteDepartment(id);
    if (!deleted) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    return NextResponse.json({ deleted: true, id });
  } catch (error) {
    console.error(`DELETE /api/crm/departments/${id} failed:`, error);
    return NextResponse.json({ error: msg(error) }, { status: 500 });
  }
}
