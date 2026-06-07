import {
  readLlamaCppBaseUrl,
  readLlamaCppModel,
  readOllamaBaseUrl,
  readRuntimeKind,
  SSE_HEADERS,
  sseStreamFromEvents,
  streamLocalChat,
} from '@umb-advisors/llm';
import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { llmChatStreamBodySchema } from '@/lib/schemas/internal';

// POST /api/internal/llm/api/chat/stream — interactive token streaming for the
// chat UI (MBOX-284 / DR-25). Relays the LOCAL runtime's tokens to the browser
// as Server-Sent Events. This is the first token-by-token consumer of the
// DR-25 proxy; the non-streaming /api/chat sibling (stream:false, used by the
// MailBOX-Draft pipeline) is unchanged.
//
// LOCAL-ONLY (DR-53 / SM-73): the only baseUrls this route can resolve are the
// on-device runtimes (readOllamaBaseUrl / readLlamaCppBaseUrl). There is no
// branch — and the request schema has no field — that can point this at a cloud
// provider. A local-runtime outage surfaces as an SSE `event: error` with
// `code: "local_unavailable"`, kept distinct from a clean empty completion.
//
// ON-BOX VALIDATION REQUIRED: the relay is unit-tested against a mocked upstream
// stream; the real llama.cpp /v1/chat/completions SSE framing and first-token
// latency (SM-70, p95 < 3s) must be measured on M1/M2.

// SSE requires the response to stream; opt out of static optimization.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const parsed = await parseJson(req, llmChatStreamBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const runtime = readRuntimeKind();
  // LOCAL-ONLY: resolve baseUrl + model strictly from the on-device runtime
  // config. No cloud path is reachable from here (DR-53 / SM-73).
  const baseUrl = runtime === 'llama-cpp' ? readLlamaCppBaseUrl() : readOllamaBaseUrl();
  const model = runtime === 'llama-cpp' ? readLlamaCppModel() : (body.model ?? 'qwen3:4b-ctx4k');

  const events = streamLocalChat(
    runtime,
    { messages: body.messages, options: body.options },
    { baseUrl, model, signal: req.signal },
  );

  const stream = sseStreamFromEvents(events, runtime);
  return new NextResponse(stream, { status: 200, headers: SSE_HEADERS });
}
