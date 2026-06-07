import { type NextRequest, NextResponse } from 'next/server';
import { parseJson, parseQuery } from '@/lib/middleware/validate';
import { appendMessage, getConversationMessages } from '@/lib/queries-chat';
import { chatMessageCreateSchema, chatMessagesQuerySchema } from '@/lib/schemas/chat';

// MBOX-285 — chat message read/write (internal). Append a turn (POST) or load a
// conversation's turns in order (GET ?conversation_id=N). Called by the
// /dashboard/chat route (MBOX-287) inside the docker network; local-only
// (NFR-7), Caddy basic_auth on the public surface (FR-26).

export const dynamic = 'force-dynamic';

// GET /api/internal/chat/messages?conversation_id=N — replay history.
export async function GET(req: NextRequest) {
  const q = parseQuery(req, chatMessagesQuerySchema);
  if (!q.ok) return q.response;

  try {
    const messages = await getConversationMessages(q.data.conversation_id);
    return NextResponse.json({ messages });
  } catch (error) {
    console.error('GET /api/internal/chat/messages failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

// POST /api/internal/chat/messages — append a turn. Assistant turns may carry
// model/tokens/rag_context_refs/rag_retrieval_reason; user/system turns omit
// them. The FK + ON DELETE CASCADE means a message for a missing conversation
// is a 23503 foreign-key violation — surfaced as a 400 (bad conversation_id)
// rather than a 500.
export async function POST(req: NextRequest) {
  const parsed = await parseJson(req, chatMessageCreateSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const message = await appendMessage({
      conversation_id: parsed.data.conversation_id,
      role: parsed.data.role,
      content: parsed.data.content,
      model: parsed.data.model ?? null,
      input_tokens: parsed.data.input_tokens ?? null,
      output_tokens: parsed.data.output_tokens ?? null,
      rag_context_refs: parsed.data.rag_context_refs,
      rag_retrieval_reason: parsed.data.rag_retrieval_reason,
    });
    return NextResponse.json(message, { status: 201 });
  } catch (error) {
    // 23503 = FK violation: conversation_id doesn't exist. Client error, not ours.
    if (error && typeof error === 'object' && 'code' in error && error.code === '23503') {
      return NextResponse.json(
        { error: 'conversation_id does not reference an existing conversation' },
        { status: 400 },
      );
    }
    console.error('POST /api/internal/chat/messages failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
