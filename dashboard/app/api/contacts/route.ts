import { NextResponse } from 'next/server';
import { getContacts } from '@/lib/contacts/contacts';

export const dynamic = 'force-dynamic';

// MBOX-398 — operator-facing Contacts (Google People API) for the right-rail
// panel. Search is client-side over the returned list (≤200). Caddy basic_auth
// gated. Never 500s — returns the typed reason for connect/retry states.
export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await getContacts());
  } catch (error) {
    console.error('GET /api/contacts failed:', error);
    return NextResponse.json({ reason: 'fetch_failed', contacts: [] });
  }
}
