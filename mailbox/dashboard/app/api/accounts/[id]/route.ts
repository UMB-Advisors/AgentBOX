import { type NextRequest, NextResponse } from 'next/server';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import {
  AccountMutationError,
  deleteAccount,
  setDefaultAccount,
  updateAccount,
} from '@/lib/queries-accounts';
import { accountIdParamSchema, accountUpdateSchema } from '@/lib/schemas/accounts';

// MBOX-366 (MBOX-162 V5) — per-account registry mutations (operator-facing,
// Caddy basic_auth gated).
//
// PATCH  /api/accounts/[id]  → { account } — edit label/provider and/or
//                              make_default:true (re-points the default inbox).
// DELETE /api/accounts/[id]  → { deleted, id } | 404 | 409 (default / has data)

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const params = await props.params;
  const p = parseParams(params, accountIdParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const parsed = await parseJson(request, accountUpdateSchema);
  if (!parsed.ok) return parsed.response;

  try {
    // Apply label/provider edits first (if any), then the default swap — so a
    // single PATCH that both relabels and promotes lands both, with the
    // set-default result (authoritative is_default) returned.
    let account = await updateAccount(id, {
      display_label: parsed.data.display_label,
      provider: parsed.data.provider,
    });
    if (!account) {
      return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    }
    if (parsed.data.make_default) {
      account = await setDefaultAccount(id);
    }
    return NextResponse.json({ account });
  } catch (error) {
    if (error instanceof AccountMutationError && error.code === 'not_found') {
      return NextResponse.json({ error: error.code, id }, { status: 404 });
    }
    console.error(`PATCH /api/accounts/${id} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  props: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const params = await props.params;
  const p = parseParams(params, accountIdParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  try {
    const deleted = await deleteAccount(id);
    if (!deleted) {
      return NextResponse.json({ error: 'not_found', id }, { status: 404 });
    }
    return NextResponse.json({ deleted: true, id });
  } catch (error) {
    // Guard failures (default inbox / has history) → 409, not 500.
    if (
      error instanceof AccountMutationError &&
      (error.code === 'cannot_delete_default' || error.code === 'account_has_data')
    ) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 409 });
    }
    console.error(`DELETE /api/accounts/${id} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
