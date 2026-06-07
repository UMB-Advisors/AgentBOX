import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { getPersona, upsertPersona } from '@/lib/queries-persona';
import { personaUpdateSchema } from '@/lib/schemas/persona';

// STAQPRO-149: operator-facing CRUD for the persona that drives draft voice.
// Default `customer_key='default'` for the single-customer-per-appliance era.
// When STAQPRO-153 (persona extraction) lands, the read here will surface the
// extraction output; manual edits via PUT remain as the operator override.

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const persona = await getPersona();
    return NextResponse.json({ persona });
  } catch (error) {
    console.error('GET /api/persona failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const parsed = await parseJson(request, personaUpdateSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const current = await getPersona();
    const sourceCount = current?.source_email_count ?? 0;
    const persona = await upsertPersona(
      parsed.data.statistical_markers,
      parsed.data.category_exemplars,
      sourceCount,
    );
    return NextResponse.json({ persona });
  } catch (error) {
    console.error('PUT /api/persona failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
