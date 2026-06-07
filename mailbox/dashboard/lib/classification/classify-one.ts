// STAQPRO-370 — shared classify-one chain for backlog cleanup paths.
//
// Both `scripts/classify-backfill.ts` (operator one-shot, STAQPRO-368) and
// `app/api/internal/classify-sweep/route.ts` (periodic sweeper, this issue)
// need to run the exact same classify chain that `MailBOX-Classify` runs in
// the live pipeline. Until this module landed, the script reimplemented the
// chain inline. The sweeper would have done the same, duplicating the
// "prompt → ollama → normalize → log" sequence for the third time. Pull it
// out once.
//
// Scope is intentionally narrow — backlog rows that arrived via
// FetchHistory (or were missed during n8n downtime). Skipped vs the live
// chain:
//
//   - Live Gate check (`/api/onboarding/live-gate`): backlog rows predate
//     the gate's intent; we don't want one disabled appliance to leave a
//     permanent unclassified cohort.
//   - Drop-spam IF gate / Insert Draft Stub / Trigger Draft Sub: backlog
//     rows are days/weeks old; auto-drafting historical mail is a separate
//     decision (operator usually doesn't want that — see STAQPRO-368
//     scope note).
//
// Goal is exactly: restore visibility on the Classifications page + give
// RAG retrieval a `classification_category` payload to filter on. Drafts,
// gates, and sends are not the sweeper's job.
//
// The chain calls dashboard helpers directly (no HTTP hop) — this code
// runs in the dashboard container alongside the route handlers, so a
// fetch() against localhost would just be wasted latency.

import { readOllamaBaseUrl } from '@umb-advisors/llm';
import { getPersonaContext } from '@/lib/drafting/persona';
import { type ClassificationResult, normalizeClassifierOutput } from './normalize';
import { buildPrompt, MODEL_VERSION } from './prompt';

export interface InboxRowForClassify {
  id: number;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  body: string | null;
  snippet: string | null;
}

export interface ClassifyOneResult {
  inbox_message_id: number;
  category: ClassificationResult['category'];
  confidence: number;
  model_version: string;
  latency_ms: number;
  raw_output: string;
  json_parse_ok: boolean;
  think_stripped: boolean;
  preclass_applied: boolean;
  preclass_source: ClassificationResult['preclass_source'];
}

export interface ClassifyOneDeps {
  /**
   * Fetch implementation — injectable for tests. Defaults to global fetch.
   */
  fetchImpl?: typeof fetch;
  /**
   * Base URL of the local Ollama runtime serving Qwen3 classification.
   * Defaults to `readOllamaBaseUrl()` (env: `OLLAMA_BASE_URL`, fallback
   * `http://ollama:11434`), matching the live `MailBOX-Classify > Call
   * Ollama` node verbatim. DR-25 cutover (llama.cpp drafting) does NOT
   * affect this URL — Ollama still serves the classifier on the live
   * appliance.
   */
  llmBaseUrl?: string;
  /**
   * MBOX-370 — sender is on the never-spam allowlist. Forwarded into the
   * normalize ctx so the heuristic suppressions (noreply / self-loop) are
   * skipped and the real category stands. Used by the reclassify-by-sender
   * re-run (where the sender is allowlisted by construction).
   */
  neverSpam?: boolean;
}

// Mirror of the live `MailBOX-Classify > Call Ollama` body. Kept here as a
// type so the call site below stays self-documenting.
interface LocalGenerateBody {
  model: string;
  prompt: string;
  stream: false;
  format: 'json';
  think: false;
  options: { temperature: number };
}

interface LocalGenerateResponse {
  response?: string;
  thinking?: string;
}

// Compose the same framing the `POST /api/internal/classification-prompt`
// route uses. Inlined rather than HTTP'd because we already share a process
// with that route.
async function buildFramedPrompt(row: InboxRowForClassify): Promise<string> {
  // Mirrors `personaToClassifyFraming` in
  // app/api/internal/classification-prompt/route.ts. Three-layer fallback
  // (operator override → extraction-derived → hardcoded default) lives inside
  // getPersonaContext per STAQPRO-195.
  const persona = await getPersonaContext();
  const brand = persona.operator_brand?.trim() ?? '';
  const desc = persona.business_description?.trim() ?? '';
  let framing = '';
  if (desc && brand && brand !== "the operator's business") {
    framing = `${brand} — ${desc}`;
  } else if (desc) {
    framing = desc;
  }
  return buildPrompt(
    {
      from: row.from_addr ?? '',
      subject: row.subject ?? '',
      body: row.body ?? row.snippet ?? '',
    },
    framing,
  );
}

/**
 * Run the classify chain for one inbox row. Pure function over the supplied
 * row + deps — does NOT touch Postgres. The caller is responsible for
 * writing the resulting row to `mailbox.classification_log` (so callers can
 * batch the writes inside their own transaction if they want).
 *
 * Throws on infra failure (LLM call non-200, malformed JSON output of the
 * pipeline itself). The caller decides whether to swallow the error and
 * keep processing or abort the batch.
 */
export async function classifyOne(
  row: InboxRowForClassify,
  deps: ClassifyOneDeps = {},
): Promise<ClassifyOneResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = deps.llmBaseUrl ?? readOllamaBaseUrl();

  const prompt = await buildFramedPrompt(row);

  const body: LocalGenerateBody = {
    model: MODEL_VERSION,
    prompt,
    stream: false,
    format: 'json',
    // Mirrors the n8n `Call Ollama` body + the live classify route + the
    // STAQPRO-240 fix. On Ollama < 0.21 the field is ignored (M1
    // historical); on 0.23+ (M2 + M1 post-2026-05-08 unify) it disables
    // Qwen3 thinking-mode.
    think: false,
    options: { temperature: 0 },
  };

  const t0 = Date.now();
  const res = await fetchImpl(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`local LLM /api/generate -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as LocalGenerateResponse;
  const latency_ms = Date.now() - t0;

  // Defensive: if a future runtime revives thinking-mode despite think:false,
  // fall back to the thinking field. Same shape as the n8n Normalize node's
  // `$json.response || $json.thinking || ''`.
  const rawOutput = json.response ?? json.thinking ?? '';

  const normalized = normalizeClassifierOutput(rawOutput, {
    from: row.from_addr ?? undefined,
    to: row.to_addr ?? undefined,
    neverSpam: deps.neverSpam,
  });

  return {
    inbox_message_id: row.id,
    category: normalized.category,
    confidence: normalized.confidence,
    model_version: MODEL_VERSION,
    latency_ms,
    raw_output: normalized.raw_output,
    json_parse_ok: normalized.json_parse_ok,
    think_stripped: normalized.think_stripped,
    preclass_applied: normalized.preclass_applied,
    preclass_source: normalized.preclass_source,
  };
}
