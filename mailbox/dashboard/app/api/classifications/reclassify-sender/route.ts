import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import {
  countSenderEmails,
  reclassifySenderEmails,
  upsertNeverSpam,
} from '@/lib/queries-sender-allowlist';
import { reclassifyBySenderBodySchema } from '@/lib/schemas/classifications';

export const dynamic = 'force-dynamic';

// MBOX-370 — operator "reclassify automatically" for a sender. Operator-facing
// (Caddy basic_auth gated at the public edge); called from the /classifications
// page. Replaces the MBOX-368 force-to-category model (operator feedback: a
// sender wrongly dropped as spam can send any non-spam type later).
//
// FAST PATH (MBOX-370 follow-up fix): await ONLY the never-spam upsert (the
// future protection — the part that matters) + a quick count, then return
// immediately. The PAST re-classify (up to 50 local LLM calls, minutes long) is
// fired in the BACKGROUND so the response — and the UI — never blocks. Re-running
// it synchronously held the request open for minutes and greyed the queue.
//
// Body { email, reason? } (zod reclassifyBySenderBodySchema; `email` normalized
// via extractAddress). Returns { success, email, allowlisted, queued, capped }.
export async function POST(req: NextRequest) {
  const b = await parseJson(req, reclassifyBySenderBodySchema);
  if (!b.ok) return b.response;
  const { email, reason } = b.data;

  try {
    await upsertNeverSpam(email, reason);
    const { count, capped } = await countSenderEmails(email);

    // Fire-and-forget the slow re-classify. The allowlist is already saved, so
    // the sender is protected going forward regardless of how the loop fares.
    // Errors are logged, never surfaced to the (already-sent) response.
    void reclassifySenderEmails(email).catch((error) => {
      console.error(`[reclassify] background re-classify failed for ${email}:`, error);
    });

    return NextResponse.json({ success: true, email, allowlisted: true, queued: count, capped });
  } catch (error) {
    console.error('POST /api/classifications/reclassify-sender failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
