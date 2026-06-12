import { type NextRequest, NextResponse } from 'next/server';
import { finishWriteThrough } from '@/lib/inbox-actions';
import { parseParams } from '@/lib/middleware/validate';
import { applyArchive } from '@/lib/queries-inbox-actions';
import { idParamSchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

// MBOX-369 — archive a queue row. Hides it locally (archived_at) and fans out to
// Gmail (messages.modify removeLabelIds [INBOX]). Per the MBOX-369 decision,
// archive KEEPS any pending draft (operator may still reply); only delete
// discards it.
export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;
  try {
    const target = await applyArchive(id);
    return await finishWriteThrough(id, 'archive', target, 'archive');
  } catch (error) {
    console.error(`POST /api/inbox-messages/${id}/archive failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
