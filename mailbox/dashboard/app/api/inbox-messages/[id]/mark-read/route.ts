import { type NextRequest, NextResponse } from 'next/server';
import { finishWriteThrough } from '@/lib/inbox-actions';
import { parseParams } from '@/lib/middleware/validate';
import { applyMarkRead } from '@/lib/queries-inbox-actions';
import { idParamSchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

// MBOX-369 — mark a queue row read. Clears the unread dot locally (is_read) and
// fans out to Gmail (messages.modify removeLabelIds [UNREAD]). Per the MBOX-369
// decision, the row STAYS in the queue — read is a visual state, not a disposal.
export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;
  try {
    const target = await applyMarkRead(id);
    return await finishWriteThrough(id, 'mark-read', target, 'mark_read');
  } catch (error) {
    console.error(`POST /api/inbox-messages/${id}/mark-read failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
