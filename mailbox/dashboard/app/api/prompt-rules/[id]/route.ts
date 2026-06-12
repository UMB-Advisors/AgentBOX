import { type NextRequest, NextResponse } from 'next/server';
import { parseJson, parseParams, parseQuery } from '@/lib/middleware/validate';
import { deletePromptRule, updatePromptRule } from '@/lib/queries-prompt-rules';
import { accountQuerySchema } from '@/lib/schemas/common';
import { promptRuleIdParamSchema, promptRuleUpdateSchema } from '@/lib/schemas/prompt-rules';

// MBOX-162 P5b — edit / remove a single drafting guideline.
//
// MBOX-374 — account-scoped via `?account=<id>` (absent → default account); the
// query scopes the UPDATE/DELETE to that account, so a rule from another inbox
// can't be edited cross-account (a foreign id → 404).
// PATCH  /api/prompt-rules/[id][?account=<id>] → { rule } | 404. Content edits
//                                 bump version; an enabled-only toggle does not.
// DELETE /api/prompt-rules/[id][?account=<id>] → { deleted: true, id } | 404.

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const params = await props.params;
  const p = parseParams(params, promptRuleIdParamSchema);
  if (!p.ok) return p.response;
  const q = parseQuery(request, accountQuerySchema);
  if (!q.ok) return q.response;
  const parsed = await parseJson(request, promptRuleUpdateSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const rule = await updatePromptRule(p.data.id, parsed.data, q.data.account);
    if (!rule) {
      return NextResponse.json({ error: 'not_found', id: p.data.id }, { status: 404 });
    }
    return NextResponse.json({ rule });
  } catch (error) {
    console.error(`PATCH /api/prompt-rules/${p.data.id} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const params = await props.params;
  const p = parseParams(params, promptRuleIdParamSchema);
  if (!p.ok) return p.response;
  const q = parseQuery(request, accountQuerySchema);
  if (!q.ok) return q.response;

  try {
    const deleted = await deletePromptRule(p.data.id, q.data.account);
    if (!deleted) {
      return NextResponse.json({ error: 'not_found', id: p.data.id }, { status: 404 });
    }
    return NextResponse.json({ deleted: true, id: p.data.id });
  } catch (error) {
    console.error(`DELETE /api/prompt-rules/${p.data.id} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
