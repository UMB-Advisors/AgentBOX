import { type NextRequest, NextResponse } from 'next/server';
import { finishWriteThrough } from '@/lib/inbox-actions';
import { parseParams } from '@/lib/middleware/validate';
import { applyDeleteAndRejectDraft } from '@/lib/queries-inbox-actions';
import { idParamSchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

// MBOX-369 — delete (trash) a queue row. Hides it locally (deleted_at), discards
// any active linked draft (status → rejected, audit reason 'message_deleted'),
// and fans out to Gmail (messages.trash — recoverable, NOT permanent delete).
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;
  try {
    const target = await applyDeleteAndRejectDraft(id);
    return await finishWriteThrough(id, 'delete', target, 'delete');
  } catch (error) {
    console.error(`POST /api/inbox-messages/${id}/delete failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
