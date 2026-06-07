// dashboard/lib/drafting/judge.ts
//
// STAQPRO-220 — LLM-judge scorer for the RAG eval harness.
//
// The judge sees a (draft, actual_reply) pair and returns three 0-3 scores:
//
//   - voice_match            (does the draft sound like the operator?)
//   - factual_alignment      (does the draft preserve the reply's facts?)
//   - length_appropriateness (is the draft length close to the reply?)
//
// Aggregate = sum (range 0-9). The judge does NOT see the inbound — by
// design (see issue Notes). Two providers are wired:
//
//   - haiku    → Anthropic /v1/messages (claude-haiku-4-5-20251001)
//   - gpt-oss  → Ollama Cloud /api/chat (gpt-oss:120b, OpenAI-compatible
//                response shape; we read message.content like the live
//                drafter does)
//
// Both share the same prompt, same expected JSON output, same parser. The
// only thing that changes is the HTTP call shape. Failures (network, 5xx,
// parse error, missing field) collapse to a `parse_failed` status so the
// harness can keep going and the operator can see judge dropouts in the
// final status_counts.
//
// Eval-only: this module is NOT used by the live drafting path. It exists
// so the eval harness can run a second metric in parallel with cosine
// without leaking judge-of-prod-drafts behavior into the production path.

export type JudgeProvider = 'haiku' | 'gpt-oss';

// STAQPRO-224 — `rate_limited` is split out from `call_failed` so the operator
// can distinguish a transient 429 (the eval already retries by spacing; rerun
// at lower --limit) from a structural call failure (key missing, bad model
// id, malformed response, etc). Counted separately in the harness'
// status_counts.judge_rate_limited bucket.
export type JudgeStatus = 'ok' | 'parse_failed' | 'call_failed' | 'rate_limited';

export interface JudgeScores {
  voice_match: number;
  factual_alignment: number;
  length_appropriateness: number;
  rationale: string;
}

export interface JudgeResult {
  status: JudgeStatus;
  // null when status !== 'ok'. The harness writes the four score fields +
  // rationale onto the per-pair JSON entry; the aggregate path filters by
  // status === 'ok'.
  scores: JudgeScores | null;
  // Diagnostic — surfaced into the per-pair JSON when present so the
  // operator can grep failed rows after a run.
  error?: string;
  // Raw model output retained on parse_failed so the operator can eyeball
  // why it didn't validate. Bounded to first 500 chars to keep the JSON
  // file from ballooning if the model regurgitates the whole prompt.
  raw?: string;
}

// =============================================================================
// Prompt builder
// =============================================================================

/**
 * Truncate a body to a soft char cap. The judge prompt grows linearly with
 * draft + reply length; capping at ~6000 chars per side keeps the worst-case
 * input under ~3K tokens (issue's cost model assumption). Truncation marker
 * is explicit so the judge knows the input was clipped.
 */
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated for judge prompt]`;
}

const JUDGE_BODY_CAP_CHARS = 6000;

export interface JudgePromptInput {
  draft: string;
  actual_reply: string;
}

/**
 * Build the user-message content for the judge call. Same string for both
 * providers (Haiku and gpt-oss accept the same chat-shape). The system
 * portion is provider-specific (Anthropic uses `system:` field;
 * Ollama uses a `role: 'system'` message) — handled in the call functions.
 */
export function buildJudgeUserMessage(input: JudgePromptInput): string {
  const draft = clip(input.draft, JUDGE_BODY_CAP_CHARS);
  const actual = clip(input.actual_reply, JUDGE_BODY_CAP_CHARS);
  return [
    "You are scoring a candidate email DRAFT against the operator's ACTUAL reply.",
    'Score each axis 0-3 (integers only). Return JSON only — no prose, no code fences.',
    '',
    'Axes:',
    '  voice_match            — 0=different writer, 3=indistinguishable from the operator',
    '  factual_alignment      — 0=contradicts the actual reply, 3=preserves all key facts',
    '  length_appropriateness — 0=way too short or too long, 3=length matches the actual reply',
    '',
    'Output schema (JSON):',
    '  { "voice_match": <0-3>, "factual_alignment": <0-3>, "length_appropriateness": <0-3>, "rationale": "<one sentence>" }',
    '',
    '--- DRAFT ---',
    draft,
    '--- END DRAFT ---',
    '',
    '--- ACTUAL REPLY ---',
    actual,
    '--- END ACTUAL REPLY ---',
  ].join('\n');
}

export const JUDGE_SYSTEM_PROMPT =
  'You are an impartial email-quality judge. You return JSON only. ' +
  'You never see the inbound message — only the draft and the actual reply. ' +
  'Score conservatively: a 3 means "essentially the same writer / same facts / same length", ' +
  'and partial matches should land at 1 or 2.';

// =============================================================================
// Parser
// =============================================================================

/**
 * Parse the raw model output into JudgeScores. Tolerates:
 *   - leading/trailing whitespace or fenced code blocks (```json ... ```)
 *   - extra commentary the model puts before/after the JSON
 * Rejects (returns null):
 *   - missing required fields
 *   - non-integer or out-of-range scores
 *   - rationale that isn't a string (we coerce to '' on missing rather
 *     than rejecting — rationale is informational)
 *
 * Out-of-range scores are clamped to 0-3 rather than rejected. The judge
 * occasionally emits 4 or -1; clamping is more useful than dropping the
 * row entirely.
 */
export function parseJudgeOutput(raw: string): JudgeScores | null {
  const json = extractJsonObject(raw);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const voice = toIntScore(parsed.voice_match);
  const facts = toIntScore(parsed.factual_alignment);
  const length = toIntScore(parsed.length_appropriateness);
  if (voice === null || facts === null || length === null) return null;

  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
  return {
    voice_match: voice,
    factual_alignment: facts,
    length_appropriateness: length,
    rationale,
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function toIntScore(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < 0) return 0;
  if (n > 3) return 3;
  return n;
}

/**
 * Pull the first balanced `{ ... }` substring out of raw output. Handles
 * fenced code blocks, leading prose, trailing commentary. Returns null if
 * no balanced object is found.
 */
function extractJsonObject(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // Strip a leading ```json or ``` fence and the matching trailing fence,
  // if both are present. Doesn't try to handle nested fences.
  let s = raw.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) s = fenceMatch[1].trim();
  // Find the first balanced `{...}` substring.
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Sum of the three axes. Range 0-9.
 */
export function judgeScoreSum(scores: JudgeScores): number {
  return scores.voice_match + scores.factual_alignment + scores.length_appropriateness;
}

// =============================================================================
// Call (provider-specific HTTP)
// =============================================================================

export interface JudgeCallDeps {
  fetchFn?: typeof fetch;
  // Pluggable env reader for tests; defaults to process.env at call time.
  env?: Record<string, string | undefined>;
}

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

const OLLAMA_CLOUD_BASE_DEFAULT = 'https://ollama.com';
const OLLAMA_CLOUD_JUDGE_MODEL_DEFAULT = 'gpt-oss:120b';

const JUDGE_MAX_OUTPUT_TOKENS = 256;
const JUDGE_TIMEOUT_MS = 60_000;

/**
 * Call the judge for a single (draft, actual_reply) pair. Always resolves
 * — never throws. Provider-specific errors collapse to a JudgeResult with
 * status `call_failed` (transport/HTTP error) or `parse_failed` (model
 * output didn't validate).
 */
export async function callJudge(
  provider: JudgeProvider,
  input: JudgePromptInput,
  deps: JudgeCallDeps = {},
): Promise<JudgeResult> {
  if (provider === 'haiku') return callHaikuJudge(input, deps);
  return callGptOssJudge(input, deps);
}

async function callHaikuJudge(input: JudgePromptInput, deps: JudgeCallDeps): Promise<JudgeResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const apiKey = env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    return {
      status: 'call_failed',
      scores: null,
      error: 'ANTHROPIC_API_KEY not set',
    };
  }

  const userMessage = buildJudgeUserMessage(input);
  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: JUDGE_MAX_OUTPUT_TOKENS,
    temperature: 0,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  };
  let res: Response;
  try {
    res = await withTimeout(
      fetchFn(`${ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      }),
      JUDGE_TIMEOUT_MS,
    );
  } catch (err) {
    return {
      status: 'call_failed',
      scores: null,
      error: errMsg(err),
    };
  }
  if (!res.ok) {
    const detail = await safeReadText(res);
    // STAQPRO-224 — split 429 out as `rate_limited` so the harness can count
    // it separately and the operator knows to space calls (or rerun) rather
    // than chase a malformed-response bug.
    return {
      status: res.status === 429 ? 'rate_limited' : 'call_failed',
      scores: null,
      error: `anthropic ${res.status}: ${detail.slice(0, 300)}`,
    };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    return { status: 'call_failed', scores: null, error: `anthropic json: ${errMsg(err)}` };
  }
  const content = extractAnthropicText(data);
  if (content === null) {
    return {
      status: 'parse_failed',
      scores: null,
      error: 'anthropic response missing content[0].text',
      raw: JSON.stringify(data).slice(0, 500),
    };
  }
  const scores = parseJudgeOutput(content);
  if (scores === null) {
    return {
      status: 'parse_failed',
      scores: null,
      error: 'judge output failed to parse',
      raw: content.slice(0, 500),
    };
  }
  return { status: 'ok', scores };
}

async function callGptOssJudge(input: JudgePromptInput, deps: JudgeCallDeps): Promise<JudgeResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const apiKey = env.OLLAMA_CLOUD_API_KEY ?? '';
  if (!apiKey) {
    return {
      status: 'call_failed',
      scores: null,
      error: 'OLLAMA_CLOUD_API_KEY not set',
    };
  }
  const baseUrl = env.OLLAMA_CLOUD_BASE_URL ?? OLLAMA_CLOUD_BASE_DEFAULT;
  const model = env.OLLAMA_CLOUD_JUDGE_MODEL ?? OLLAMA_CLOUD_JUDGE_MODEL_DEFAULT;
  const userMessage = buildJudgeUserMessage(input);
  const body = {
    model,
    stream: false,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    options: {
      temperature: 0,
      num_predict: JUDGE_MAX_OUTPUT_TOKENS,
    },
  };
  let res: Response;
  try {
    res = await withTimeout(
      fetchFn(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      }),
      JUDGE_TIMEOUT_MS,
    );
  } catch (err) {
    return { status: 'call_failed', scores: null, error: errMsg(err) };
  }
  if (!res.ok) {
    const detail = await safeReadText(res);
    // STAQPRO-224 — see Anthropic branch above for rationale.
    return {
      status: res.status === 429 ? 'rate_limited' : 'call_failed',
      scores: null,
      error: `ollama-cloud ${res.status}: ${detail.slice(0, 300)}`,
    };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    return { status: 'call_failed', scores: null, error: `ollama-cloud json: ${errMsg(err)}` };
  }
  const content = extractOllamaText(data);
  if (content === null) {
    return {
      status: 'parse_failed',
      scores: null,
      error: 'ollama-cloud response missing message.content',
      raw: JSON.stringify(data).slice(0, 500),
    };
  }
  const scores = parseJudgeOutput(content);
  if (scores === null) {
    return {
      status: 'parse_failed',
      scores: null,
      error: 'judge output failed to parse',
      raw: content.slice(0, 500),
    };
  }
  return { status: 'ok', scores };
}

// Anthropic /v1/messages response: { content: [{ type: 'text', text: '...' }, ...] }
function extractAnthropicText(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const content = data.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return null;
}

// Ollama /api/chat response: { message: { role: 'assistant', content: '...' } }
function extractOllamaText(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const message = data.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  return typeof content === 'string' ? content : null;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`judge call timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
