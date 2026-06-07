// dashboard/app/api/internal/digest/record/route.ts
//
// MBOX-132 — digest send-ledger claim (Phase 2d). POSTed by the MailBOX-Digest
// n8n workflow AFTER a successful Gmail send to claim the day in
// mailbox.digest_sends. Idempotent via the UNIQUE(sent_on) constraint
// (migration 029): the first POST for a day inserts and returns recorded=true;
// any later POST for the same day is a no-op and returns recorded=false.
//
// Claiming AFTER the send (not before) is deliberate — a failed Gmail send must
// not burn the day's slot, otherwise a transient send error would suppress the
// digest until tomorrow. n8n only reaches this node on the Gmail success branch.
//
// Body (zod — lib/schemas/digest.ts):
//   { sent_on: 'YYYY-MM-DD', recipient?: string, subject?: string }
// Response: { recorded: boolean, sent_on: string }

import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { recordDigestSendIfFirstToday } from '@/lib/queries-digest';
import { digestRecordBodySchema } from '@/lib/schemas/digest';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const b = await parseJson(req, digestRecordBodySchema);
  if (!b.ok) return b.response;
  const { sent_on, recipient, subject } = b.data;

  try {
    const recorded = await recordDigestSendIfFirstToday({ sent_on, recipient, subject });
    return NextResponse.json({ recorded, sent_on });
  } catch (error) {
    console.error('POST /api/internal/digest/record failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
