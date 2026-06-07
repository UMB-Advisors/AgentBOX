import { NextResponse } from 'next/server';
import { getTasks } from '@/lib/tasks/tasks';

export const dynamic = 'force-dynamic';

// MBOX-398 — operator-facing Google Tasks read for the right-rail panel (the
// push-to-Tasks write action is MBOX-129). Caddy basic_auth gated. Never 500s —
// returns the typed reason for connect/retry states.
export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await getTasks());
  } catch (error) {
    console.error('GET /api/tasks failed:', error);
    return NextResponse.json({ reason: 'fetch_failed', lists: [] });
  }
}
