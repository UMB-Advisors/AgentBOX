import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { createAutoSendRule, listAutoSendRules } from '@/lib/queries-auto-send';
import { autoSendRuleCreateSchema } from '@/lib/schemas/auto-send';

// MBOX-16 / FR-23 — operator-facing auto-send rule list + create (basic_auth
// gated by Caddy; NOT under /api/internal). Backs the rules page.
//
// GET  /api/auto-send-rules  → { rules: AutoSendRule[] } (priority, id order)
// POST /api/auto-send-rules  → { rule: AutoSendRule }
//
// Default-safe: a fresh appliance has no rules, so every draft falls through to
// the all-manual queue. The operator opts INTO auto-send by creating rules.

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const rules = await listAutoSendRules();
    return NextResponse.json({ rules });
  } catch (error) {
    console.error('GET /api/auto-send-rules failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseJson(request, autoSendRuleCreateSchema);
  if (!parsed.ok) return parsed.response;
  const d = parsed.data;

  try {
    const rule = await createAutoSendRule({
      name: d.name,
      enabled: d.enabled,
      priority: d.priority,
      action: d.action,
      category: d.category ?? null,
      sender_domain: d.sender_domain ?? null,
      min_confidence: d.min_confidence ?? null,
      active_from_min: d.active_from ?? null,
      active_to_min: d.active_to ?? null,
      shadow_until: d.shadow_until ?? null,
    });
    return NextResponse.json({ rule }, { status: 201 });
  } catch (error) {
    console.error('POST /api/auto-send-rules failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
