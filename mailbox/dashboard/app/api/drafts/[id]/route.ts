import { type NextRequest, NextResponse } from 'next/server';
import { parseParams } from '@/lib/middleware/validate';
import { getDraft } from '@/lib/queries';
import { idParamSchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  try {
    const draft = await getDraft(id);
    if (!draft) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(draft);
  } catch (error) {
    console.error(`GET /api/drafts/${id} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
