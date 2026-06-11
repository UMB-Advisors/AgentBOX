import { type NextRequest, NextResponse } from 'next/server';
import { deleteBusiness, updateBusiness } from '@/lib/crm/queries';

// PATCH  /api/crm/businesses/[id] {name?,description?} → { business } | 404
// DELETE /api/crm/businesses/[id]                      → { deleted, id } | 404
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
      description?: unknown;
    };
    const patch: { name?: string; description?: string } = {};
    if (typeof body.name === 'string') patch.name = body.name.trim();
    if (typeof body.description === 'string') patch.description = body.description;
    const business = await updateBusiness(id, patch);
    if (!business) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    return NextResponse.json({ business });
  } catch (error) {
    console.error(`PATCH /api/crm/businesses/${id} failed:`, error);
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
    const deleted = await deleteBusiness(id);
    if (!deleted) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    return NextResponse.json({ deleted: true, id });
  } catch (error) {
    console.error(`DELETE /api/crm/businesses/${id} failed:`, error);
    return NextResponse.json({ error: msg(error) }, { status: 500 });
  }
}
