import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { listVipSenders, upsertVipSender } from '@/lib/queries-vip';
import { vipSenderCreateSchema } from '@/lib/schemas/vip';

// MBOX-134 — operator-facing VIP sender list (basic_auth gated by Caddy; not
// under /api/internal). Backs the urgency engine's 'vip' signal.
//
// GET  /api/vip-senders            → { senders: VipSender[] }
// POST /api/vip-senders            → { sender: VipSender } (idempotent upsert
//                                     on (email_or_domain, kind))

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const senders = await listVipSenders();
    return NextResponse.json({ senders });
  } catch (error) {
    console.error('GET /api/vip-senders failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseJson(request, vipSenderCreateSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const sender = await upsertVipSender({
      email_or_domain: parsed.data.email_or_domain,
      kind: parsed.data.kind,
      note: parsed.data.note,
    });
    return NextResponse.json({ sender });
  } catch (error) {
    console.error('POST /api/vip-senders failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
