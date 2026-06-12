import { type NextRequest, NextResponse } from 'next/server';
import { readContactPatch } from '@/lib/crm/coerce';
import { deleteContact, updateContact } from '@/lib/crm/queries';

// PATCH  /api/crm/contacts/[id] {...partial} → { contact } | 404
// DELETE /api/crm/contacts/[id]              → { deleted, id } | 404
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
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const contact = await updateContact(id, readContactPatch(body));
    if (!contact) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    return NextResponse.json({ contact });
  } catch (error) {
    console.error(`PATCH /api/crm/contacts/${id} failed:`, error);
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
    const deleted = await deleteContact(id);
    if (!deleted) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    return NextResponse.json({ deleted: true, id });
  } catch (error) {
    console.error(`DELETE /api/crm/contacts/${id} failed:`, error);
    return NextResponse.json({ error: msg(error) }, { status: 500 });
  }
}
