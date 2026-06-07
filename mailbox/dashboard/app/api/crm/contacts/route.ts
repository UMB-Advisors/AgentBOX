import { type NextRequest, NextResponse } from 'next/server';
import { readContactInput } from '@/lib/crm/coerce';
import { createContact, listContacts } from '@/lib/crm/queries';

// AgentBOX CRM — managed contacts (phone/email/social). Caddy basic_auth gated.
// Distinct from /api/contacts (read-only Google People panel).
// GET  /api/crm/contacts        → { contacts }
// POST /api/crm/contacts {...}   → { contact }
export const dynamic = 'force-dynamic';

function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'Internal error';
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ contacts: await listContacts() });
  } catch (error) {
    console.error('GET /api/crm/contacts failed:', error);
    return NextResponse.json({ error: msg(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const input = readContactInput(body);
    if (!input) return NextResponse.json({ error: 'name required' }, { status: 400 });
    return NextResponse.json({ contact: await createContact(input) });
  } catch (error) {
    console.error('POST /api/crm/contacts failed:', error);
    return NextResponse.json({ error: msg(error) }, { status: 500 });
  }
}
