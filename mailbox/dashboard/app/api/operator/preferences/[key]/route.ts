import { type NextRequest, NextResponse } from 'next/server';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { getPreference, upsertPreference } from '@/lib/queries-preferences';
import { preferenceKeyParamSchema, preferenceUpdateSchema } from '@/lib/schemas/preferences';

// MBOX-133: operator filter/sort preference persistence. Single-operator-per-
// appliance, so no per-user keying yet (the row's operator_id is NULL). The
// dashboard's usePreference() hook reads on mount (localStorage fallback when
// the row doesn't exist or the box is offline) and writes on change.

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ key: string }> }) {
  const params = await props.params;
  const p = parseParams(params, preferenceKeyParamSchema);
  if (!p.ok) return p.response;
  const { key } = p.data;

  try {
    const pref = await getPreference(key);
    if (!pref) {
      // Nothing persisted yet — the client uses its localStorage default.
      return NextResponse.json({ error: 'Not found', key }, { status: 404 });
    }
    return NextResponse.json(pref);
  } catch (error) {
    console.error(`GET /api/operator/preferences/${key} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest, props: { params: Promise<{ key: string }> }) {
  const params = await props.params;
  const p = parseParams(params, preferenceKeyParamSchema);
  if (!p.ok) return p.response;
  const { key } = p.data;

  const parsed = await parseJson(request, preferenceUpdateSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const pref = await upsertPreference(key, parsed.data.value);
    return NextResponse.json(pref);
  } catch (error) {
    console.error(`PUT /api/operator/preferences/${key} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
