// dashboard/app/api/internal/gmail-cycle-complete/route.ts
//
// STAQPRO-226 — write-side advance for bootstrap state.
//
// Called by the n8n MailBOX parent workflow at the end of each Gmail Get
// cycle, with the count of messages the cycle returned. While bootstrap
// is incomplete, the count drives:
//   - messages_seen counter (UI denominator-less progress indicator)
//   - bootstrap_complete flip (when count < GMAIL_GET_LIMIT_BOOTSTRAP, i.e.
//     the cycle didn't fill the bucket → backlog drained)
// Once complete, the route is effectively a no-op (state already true) but
// safe to call every cycle — the UPDATE filters on bootstrap_complete=false.

import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { recordCycleComplete } from '@/lib/queries-system-state';
import { gmailCycleCompleteBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const b = await parseJson(req, gmailCycleCompleteBodySchema);
  if (!b.ok) return b.response;
  const result = await recordCycleComplete(b.data.messages_returned);
  return NextResponse.json(result);
}
