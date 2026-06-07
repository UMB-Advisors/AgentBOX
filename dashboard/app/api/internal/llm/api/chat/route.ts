import type { OllamaChatRequest, OllamaChatResponse } from '@umb-advisors/llm';
import {
  callLlamaCppChat,
  callOllamaChat,
  readLlamaCppBaseUrl,
  readLlamaCppModel,
  readOllamaBaseUrl,
  readRuntimeKind,
} from '@umb-advisors/llm';
import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { llmChatBodySchema } from '@/lib/schemas/internal';

// POST /api/internal/llm/api/chat — Ollama-shape proxy for the draft path.
// Mirrors `/api/chat` to keep the n8n workflow's `={{ baseUrl }}/api/chat`
// template valid when baseUrl points at the dashboard. STAQPRO-338 / DR-25.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const parsed = await parseJson(req, llmChatBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data as OllamaChatRequest;

  const runtime = readRuntimeKind();
  try {
    let result: OllamaChatResponse;
    if (runtime === 'llama-cpp') {
      // MBOX-120 — forward an Ollama-shape `options.grammar` (a GBNF string) to
      // the llama.cpp upstream as its native `grammar` field. We carry it on the
      // request body's `options` bag (Ollama wire shape) rather than the deps
      // arg, because `LlamaCppCallDeps` is strictly `{ baseUrl, model }`. Only
      // attach the top-level `grammar` mirror when present so the unconstrained
      // path is byte-identical to before.
      //
      // NOTE: `@umb-advisors/llm` ^0.1.0's `chatRequestToLlamaCpp` maps the
      // Ollama options bag onto `/v1/chat/completions` params and does NOT yet
      // surface `grammar` to llama.cpp's `/completion` `grammar` field — so this
      // is a no-op against the current translator. That's acceptable for the
      // MBOX-120 spike (flag default OFF); the grammar still rides on the wire
      // so a package bump that adds GBNF mapping picks it up with no route edit.
      const grammar = (body.options as { grammar?: unknown } | undefined)?.grammar;
      const llamaCppBody: OllamaChatRequest =
        typeof grammar === 'string' && grammar.length > 0
          ? { ...body, options: { ...body.options, grammar } }
          : body;
      result = await callLlamaCppChat(llamaCppBody, {
        baseUrl: readLlamaCppBaseUrl(),
        model: readLlamaCppModel(),
      });
    } else {
      result = await callOllamaChat(body, { baseUrl: readOllamaBaseUrl() });
    }
    return NextResponse.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: 'upstream_failed', runtime, upstream_detail: detail },
      { status: 502 },
    );
  }
}
