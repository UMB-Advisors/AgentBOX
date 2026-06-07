// Drafting endpoint router (2026-04-30 cloud-path pivot; 2026-05-13 DR-25 amend).
//
// Given a classification category + confidence, return the Ollama-compatible
// endpoint, model, and credentials that the n8n MailBOX-Draft workflow should
// use. Local and cloud share the same /api/chat schema, so the only thing
// that changes is baseUrl + model + apiKey.
//
// DR-25: when LOCAL_INFERENCE_RUNTIME=llama-cpp, the local route points at
// the dashboard's own /api/internal/llm proxy. The proxy translates between
// Ollama and llama.cpp wire shapes upstream; n8n still sees an Ollama
// envelope. LOCAL_INFERENCE_RUNTIME=ollama (default) keeps the historical
// direct-Ollama path with zero proxy overhead.
//
// The routing rule itself lives in lib/classification/prompt.ts:routeFor.
// MailBOX-Draft has no IF node; n8n's HTTP Request uses whatever
// baseUrl/model/apiKey /api/internal/draft-prompt returns. (Historical D-30
// reference to an IF node mirroring routeFor is stale — that fork no longer
// exists in the workflow JSONs.)

import { readLlamaCppModel, readOllamaBaseUrl, readRuntimeKind } from '@umb-advisors/llm';
import type { Category } from '@/lib/classification/prompt';
import { routeFor } from '@/lib/classification/prompt';
import { DRAFT_CLOUD_MODEL_DEFAULT, DRAFT_LOCAL_MODEL } from './prompt';

export type DraftSource = 'local' | 'cloud';

export interface DraftEndpoint {
  source: DraftSource;
  // Base URL to POST `/api/chat` against (Ollama-compatible).
  baseUrl: string;
  model: string;
  // API key to attach as `Authorization: Bearer <key>`. Empty string for
  // local Ollama (no auth on the internal Docker network).
  apiKey: string;
  // Surfaced for the dashboard UI / logs only — n8n doesn't need it.
  display_label: string;
}

const OLLAMA_CLOUD_BASE = process.env.OLLAMA_CLOUD_BASE_URL ?? 'https://ollama.com';
const OLLAMA_CLOUD_MODEL = process.env.OLLAMA_CLOUD_MODEL ?? DRAFT_CLOUD_MODEL_DEFAULT;
const OLLAMA_CLOUD_KEY = process.env.OLLAMA_CLOUD_API_KEY ?? '';

// In-cluster dashboard URL. n8n composes `${baseUrl}/api/chat` against this
// when the local runtime is llama-cpp; the path resolves to the proxy at
// dashboard/app/api/internal/llm/api/chat/route.ts. The `/dashboard/` prefix is
// the Next.js App Router basePath configured in `dashboard/next.config.mjs` —
// every internal-route URL crossing the docker network into the dashboard must
// include it (STAQPRO-360 root-cause of the 2026-05-14 cutover revert).
const DASHBOARD_LLM_PROXY_BASE =
  process.env.DASHBOARD_LLM_PROXY_BASE_URL ??
  'http://mailbox-dashboard:3001/dashboard/api/internal/llm';

function pickLocalEndpoint(): DraftEndpoint {
  const runtime = readRuntimeKind();
  if (runtime === 'llama-cpp') {
    // The llama-cpp branch resolves its model via readLlamaCppModel()
    // (DR-25 — runtime-specific gguf path). The MAILBOX_LOCAL_MODEL_OVERRIDE
    // knob is Ollama-tag-shaped and is NOT applied here. To A/B a llama-cpp
    // candidate, swap the model the proxy serves upstream.
    const model = readLlamaCppModel();
    return {
      source: 'local',
      baseUrl: DASHBOARD_LLM_PROXY_BASE,
      model,
      apiKey: '',
      display_label: `Local llama.cpp (${model})`,
    };
  }
  // MAILBOX_LOCAL_MODEL_OVERRIDE: A/B shadow knob for local-model swaps on
  // the Ollama runtime (e.g., Qwen3-4B → Qwen3.5-4B or Gemma 4 E4B).
  // Strategic direction is local-first; this knob lets us compare local-model
  // candidates on the same hardware without changing routing logic. The
  // override must name a model already pulled into the local Ollama daemon
  // (`ollama pull <tag>` on the appliance) — otherwise the draft call 404s.
  // Default unset = baseline (DRAFT_LOCAL_MODEL).
  const localModel = process.env.MAILBOX_LOCAL_MODEL_OVERRIDE?.trim() || DRAFT_LOCAL_MODEL;
  return {
    source: 'local',
    baseUrl: readOllamaBaseUrl(),
    model: localModel,
    apiKey: '',
    display_label: `Local Ollama (${localModel})`,
  };
}

export function pickEndpoint(category: Category, confidence: number): DraftEndpoint {
  const route = routeFor(category, confidence);
  if (route === 'cloud') {
    return {
      source: 'cloud',
      baseUrl: OLLAMA_CLOUD_BASE,
      model: OLLAMA_CLOUD_MODEL,
      apiKey: OLLAMA_CLOUD_KEY,
      display_label: `Ollama Cloud (${OLLAMA_CLOUD_MODEL})`,
    };
  }
  return pickLocalEndpoint();
}
