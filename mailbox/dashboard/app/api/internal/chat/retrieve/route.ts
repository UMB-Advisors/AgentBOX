import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { retrieveForChat } from '@/lib/rag/chat-retrieve';
import { chatRetrieveSchema } from '@/lib/schemas/chat';

// MBOX-283 — chat retrieval endpoint (epic MBOX-282). Query-scoped top-k over
// the email_messages Qdrant collection with a relevance floor. The
// /dashboard/chat route (MBOX-287) calls this inside the docker network to
// ground a chat answer in the customer's own corpus, then persists the
// returned point UUIDs into chat_messages.rag_context_refs (MBOX-285).
//
// Internal route: docker-network-only, never traverses Caddy (the Caddy
// basic_auth gate covers the public surface; internal routes are reached via
// http://mailbox-dashboard:3001/... from inside the network). Matches the
// §7.9 internal-route rule and the existing /api/internal/chat/* siblings.
//
// Failure semantics: always 200 with a success-shaped body. retrieveForChat
// returns { refs: [], reason } on embed/Qdrant outage or below-floor — RAG is
// augmentation, not a gate, so the chat answer proceeds without sources.

export const dynamic = 'force-dynamic';

// POST /api/internal/chat/retrieve
// Request:  { query: string }
// Response: { refs: [{ point_id, message_id, excerpt, score }], reason }
export async function POST(req: NextRequest) {
  const parsed = await parseJson(req, chatRetrieveSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await retrieveForChat(parsed.data.query, parsed.data.account_id);
    return NextResponse.json(result);
  } catch (error) {
    // retrieveForChat is designed not to throw, but a defensive 500 keeps the
    // contract honest if an unexpected error escapes.
    console.error('POST /api/internal/chat/retrieve failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
