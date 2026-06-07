import type { OllamaGenerateRequest, OllamaGenerateResponse } from '@umb-advisors/llm';
import {
  callLlamaCppGenerate,
  callOllamaGenerate,
  readLlamaCppBaseUrl,
  readLlamaCppModel,
  readOllamaBaseUrl,
  readRuntimeKind,
} from '@umb-advisors/llm';
import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { llmGenerateBodySchema } from '@/lib/schemas/internal';

// POST /api/internal/llm/api/generate — Ollama-shape proxy for the classify path.
// Forwards to Ollama or llama.cpp based on LOCAL_INFERENCE_RUNTIME. The URL
// suffix mirrors Ollama's `/api/generate` so n8n workflow JSONs can swap the
// baseUrl host without changing the path layout. STAQPRO-338 / DR-25.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const parsed = await parseJson(req, llmGenerateBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data as OllamaGenerateRequest;

  const runtime = readRuntimeKind();
  try {
    let result: OllamaGenerateResponse;
    if (runtime === 'llama-cpp') {
      result = await callLlamaCppGenerate(body, {
        baseUrl: readLlamaCppBaseUrl(),
        model: readLlamaCppModel(),
      });
    } else {
      result = await callOllamaGenerate(body, { baseUrl: readOllamaBaseUrl() });
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
