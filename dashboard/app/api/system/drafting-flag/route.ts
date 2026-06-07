// dashboard/app/api/system/drafting-flag/route.ts
//
// MBOX-288 (DR-54 / §7.11.3) — live read of the honest in-flight "drafting"
// flag. The /dashboard/chat UI (MBOX-287) polls this while a chat turn waits
// behind the drafts-priority pipeline (DR-54), so the indicator reflects ACTUAL
// pipeline state from mailbox.drafts + mailbox.state_transitions — never a
// client-side timeout guess.
//
// Sibling to /api/system/gmail-cooldown: same operator-facing read shape,
// gated by Caddy basic_auth via the /dashboard/* matcher (this lives under the
// dashboard basePath — see "Dashboard runs under basePath /dashboard").
//
// Response is a flat JSON view of the DraftingFlag discriminated union:
//   { drafting: true,  draft_id, counterparty, subject, since }
//   { drafting: false }

import { NextResponse } from 'next/server';
import { getDraftingFlag } from '@/lib/queries-drafting-flag';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const flag = await getDraftingFlag();
  return NextResponse.json(flag);
}
