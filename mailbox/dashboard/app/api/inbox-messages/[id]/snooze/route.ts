import { type NextRequest, NextResponse } from 'next/server';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { applySnooze } from '@/lib/queries-inbox-actions';
import { idParamSchema } from '@/lib/schemas/common';
import { snoozeBodySchema } from '@/lib/schemas/inbox-actions';

export const dynamic = 'force-dynamic';

// MBOX-369 — snooze a queue row until `until` (an absolute ISO instant resolved
// client-side from the chosen preset). Appliance-LOCAL only: Gmail has no snooze
// API, so there is no webhook fan-out. The row is hidden until snooze_until
// passes, then the queue predicate resurfaces it automatically.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const b = await parseJson(req, snoozeBodySchema);
  if (!b.ok) return b.response;
  const { until } = b.data;

  try {
    const target = await applySnooze(id, until);
    if (!target) {
      return NextResponse.json({ error: 'Inbox message not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, id, snooze_until: until });
  } catch (error) {
    console.error(`POST /api/inbox-messages/${id}/snooze failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
