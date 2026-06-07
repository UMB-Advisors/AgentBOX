import { type NextRequest, NextResponse } from 'next/server';
import { parseJson, parseQuery } from '@/lib/middleware/validate';
import { createPromptRule, listPromptRules } from '@/lib/queries-prompt-rules';
import { accountQuerySchema } from '@/lib/schemas/common';
import { promptRuleCreateSchema } from '@/lib/schemas/prompt-rules';

// MBOX-162 P5b — operator drafting guidelines (basic_auth gated by Caddy; not
// under /api/internal). Backs the Guidelines tab of /settings/tuning and the
// rulesSystemBlock prompt injection.
//
// MBOX-374 — account-scoped via `?account=<id>` (absent → default account).
// GET  /api/prompt-rules[?account=<id>] → { rules: PromptRule[] }
// POST /api/prompt-rules[?account=<id>] → { rule: PromptRule } (version 1, enabled)

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const q = parseQuery(request, accountQuerySchema);
  if (!q.ok) return q.response;
  try {
    const rules = await listPromptRules(q.data.account);
    return NextResponse.json({ rules });
  } catch (error) {
    console.error('GET /api/prompt-rules failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const q = parseQuery(request, accountQuerySchema);
  if (!q.ok) return q.response;
  const parsed = await parseJson(request, promptRuleCreateSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const rule = await createPromptRule(
      {
        scope: parsed.data.scope,
        rule: parsed.data.rule,
        rationale: parsed.data.rationale,
        created_by: 'operator',
      },
      q.data.account,
    );
    return NextResponse.json({ rule });
  } catch (error) {
    console.error('POST /api/prompt-rules failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
