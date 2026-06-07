import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { createConversation, listConversations } from '@/lib/queries-chat';
import { chatConversationCreateSchema } from '@/lib/schemas/chat';

// MBOX-285 — chat conversation read/write (internal). Called by the
// /dashboard/chat route (MBOX-287) inside the docker network. History is
// local-only (NFR-7); the public surface is Caddy basic_auth gated (FR-26).

export const dynamic = 'force-dynamic';

// GET /api/internal/chat/conversations — sidebar list, most-recent first.
export async function GET() {
  try {
    const conversations = await listConversations();
    return NextResponse.json({ conversations });
  } catch (error) {
    console.error('GET /api/internal/chat/conversations failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

// POST /api/internal/chat/conversations — start a session. Optional title.
export async function POST(req: NextRequest) {
  const parsed = await parseJson(req, chatConversationCreateSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const conversation = await createConversation(
      parsed.data.title ?? null,
      parsed.data.account_id,
    );
    return NextResponse.json(conversation, { status: 201 });
  } catch (error) {
    console.error('POST /api/internal/chat/conversations failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
