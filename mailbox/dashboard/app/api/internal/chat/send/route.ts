import { readRuntimeKind } from '@umb-advisors/llm';
import { type NextRequest, NextResponse } from 'next/server';
import { runChatTurn } from '@/lib/chat/orchestrate';
import { CHAT_SSE_HEADERS, chatSseStream } from '@/lib/chat/sse';
import { parseJson } from '@/lib/middleware/validate';
import { appendMessage } from '@/lib/queries-chat';
import { chatSendSchema } from '@/lib/schemas/chat';

// MBOX-287 — the single chat-send orchestration endpoint (epic MBOX-282). The
// /dashboard/chat page POSTs { conversation_id, content } here and consumes the
// returned text/event-stream. Server-side this route:
//   1. persists the user turn (MBOX-285) — done up front so a bad
//      conversation_id is a clean 400 before any stream opens (FK 23503);
//   2. hands off to runChatTurn, which retrieves (MBOX-283), assembles the
//      prompt, streams the LOCAL model (MBOX-284), and persists the assistant
//      turn (MBOX-285) on a clean 'done', emitting a terminal 'saved' event.
//
// LOCAL-ONLY (DR-53 / SM-73): the orchestration's only model seam is the
// local-runtime streaming relay. There is no cloud branch and no request field
// that could introduce one.
//
// Internal route: docker-network-only, reached from the /dashboard/chat page's
// fetch via the basePath-prefixed path. Caddy basic_auth gates the public
// surface; matches the /api/internal/chat/* siblings.
//
// ON-BOX VALIDATION REQUIRED: first-token latency (SM-70, p95 < 3s) and real
// SSE flush through Caddy (x-accel-buffering: no) can only be measured on
// M1/M2 — the orchestration is unit-tested here against a mocked stream/retrieve.

// SSE requires the response to stream; opt out of static optimization.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const parsed = await parseJson(req, chatSendSchema);
  if (!parsed.ok) return parsed.response;
  const { conversation_id, content } = parsed.data;

  // Persist the user turn before opening the stream so an invalid
  // conversation_id surfaces as a 400 (FK violation 23503) rather than a
  // mid-stream error frame the browser has to special-case. Mirrors the
  // /api/internal/chat/messages POST error mapping.
  try {
    await appendMessage({ conversation_id, role: 'user', content: content.trim() });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23503') {
      return NextResponse.json(
        { error: 'conversation_id does not reference an existing conversation' },
        { status: 400 },
      );
    }
    console.error('POST /api/internal/chat/send — user-turn persist failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }

  const events = runChatTurn(
    { conversationId: conversation_id, content, skipUserPersist: true },
    { signal: req.signal },
  );

  const stream = chatSseStream(events, readRuntimeKind());
  return new NextResponse(stream, { status: 200, headers: CHAT_SSE_HEADERS });
}
