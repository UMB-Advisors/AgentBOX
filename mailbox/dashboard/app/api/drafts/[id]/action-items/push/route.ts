import { type NextRequest, NextResponse } from 'next/server';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { idParamSchema } from '@/lib/schemas/common';
import { pushActionItemBodySchema } from '@/lib/schemas/drafts';
import { PushIndexError, PushNotFoundError, pushActionItems } from '@/lib/tasks/push';

export const dynamic = 'force-dynamic';

// MBOX-129 — operator-triggered task handoff. Pushes a draft's extracted action
// item(s) to the configured task provider (Google Tasks v1).
//
// Placed under /api/drafts/[id]/... (NOT /api/internal/) on purpose: this is
// operator-triggered from the draft-detail UI, so it must sit behind Caddy
// basic_auth like the sibling /api/drafts/[id]/action-items edit route. The
// issue's literal path (/api/internal/action-items/:id/push) would put it on
// the n8n-facing UNauthenticated surface — see report. [id] is the DRAFT id;
// action items have no DB id of their own (positional jsonb array).
//
// Body: { index: N }  → push/re-push one item;  { all: true } → bulk push all
// not-yet-pushed items.  Optional { provider } overrides the appliance default.
//
// Idempotent: re-pushing an item that already carries a task_external_id
// UPDATEs the existing task instead of creating a duplicate (lib/tasks/push.ts).
// A push failure does NOT flip draft status (Gmail send_failure convention) —
// it lands in mailbox.state_transitions with reason='push_task_failure' and is
// surfaced in the response. 200 with per-item results; 207-style partial is
// represented as ok=false entries in the results array (HTTP stays 200 when at
// least one item was addressed and the request itself was valid).
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const b = await parseJson(req, pushActionItemBodySchema);
  if (!b.ok) return b.response;

  try {
    const outcome = await pushActionItems({
      draftId: id,
      index: b.data.index,
      all: b.data.all,
      provider: b.data.provider,
    });
    return NextResponse.json({
      success: outcome.results.some((r) => r.ok),
      action_items: outcome.action_items,
      results: outcome.results,
    });
  } catch (error) {
    if (error instanceof PushNotFoundError) {
      return NextResponse.json({ error: 'draft_not_found' }, { status: 404 });
    }
    if (error instanceof PushIndexError) {
      return NextResponse.json({ error: 'index_out_of_range' }, { status: 400 });
    }
    console.error(`POST /api/drafts/${id}/action-items/push failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
