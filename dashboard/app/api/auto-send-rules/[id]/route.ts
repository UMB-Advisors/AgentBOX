import { type NextRequest, NextResponse } from 'next/server';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import {
  type AutoSendRuleInput,
  deleteAutoSendRule,
  updateAutoSendRule,
} from '@/lib/queries-auto-send';
import { autoSendRuleUpdateSchema } from '@/lib/schemas/auto-send';
import { idParamSchema } from '@/lib/schemas/common';

// MBOX-16 / FR-23 — single auto-send rule update + delete (basic_auth gated).
//
// PATCH  /api/auto-send-rules/[id]  → { rule: AutoSendRule } (404 if missing)
// DELETE /api/auto-send-rules/[id]  → { deleted: true } (404 if missing)

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;

  const parsed = await parseJson(request, autoSendRuleUpdateSchema);
  if (!parsed.ok) return parsed.response;
  const d = parsed.data;

  // Map the zod surface (active_from/active_to "HH:MM"→minutes) to DB columns,
  // forwarding ONLY keys the caller actually sent so a PATCH is a true partial.
  // The time window is all-or-nothing (schema-enforced) so we forward both
  // when either was provided.
  const patch: Partial<Omit<AutoSendRuleInput, 'created_by'>> = {};
  if ('name' in d) patch.name = d.name;
  if ('enabled' in d) patch.enabled = d.enabled;
  if ('priority' in d) patch.priority = d.priority;
  if ('action' in d) patch.action = d.action;
  if ('category' in d) patch.category = d.category ?? null;
  if ('sender_domain' in d) patch.sender_domain = d.sender_domain ?? null;
  if ('min_confidence' in d) patch.min_confidence = d.min_confidence ?? null;
  if ('active_from' in d || 'active_to' in d) {
    patch.active_from_min = d.active_from ?? null;
    patch.active_to_min = d.active_to ?? null;
  }
  if ('shadow_until' in d) patch.shadow_until = d.shadow_until ?? null;

  try {
    const rule = await updateAutoSendRule(p.data.id, patch);
    if (!rule) {
      return NextResponse.json({ error: `auto-send rule ${p.data.id} not found` }, { status: 404 });
    }
    return NextResponse.json({ rule });
  } catch (error) {
    console.error(`PATCH /api/auto-send-rules/${p.data.id} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;

  try {
    const deleted = await deleteAutoSendRule(p.data.id);
    if (!deleted) {
      return NextResponse.json({ error: `auto-send rule ${p.data.id} not found` }, { status: 404 });
    }
    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error(`DELETE /api/auto-send-rules/${p.data.id} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
