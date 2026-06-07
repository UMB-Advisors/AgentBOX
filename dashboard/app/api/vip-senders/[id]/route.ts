import { type NextRequest, NextResponse } from 'next/server';
import { parseParams } from '@/lib/middleware/validate';
import { deleteVipSender } from '@/lib/queries-vip';
import { vipSenderIdParamSchema } from '@/lib/schemas/vip';

// MBOX-134 — remove a VIP sender entry.
//
// DELETE /api/vip-senders/[id] → { deleted: true, id } | 404 when no such row.

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const p = parseParams(params, vipSenderIdParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  try {
    const deleted = await deleteVipSender(id);
    if (!deleted) {
      return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    }
    return NextResponse.json({ deleted: true, id });
  } catch (error) {
    console.error(`DELETE /api/vip-senders/${id} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
