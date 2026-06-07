// dashboard/lib/drafting/action-items.ts
//
// MBOX-131 — structured action-item extraction for a finalized draft.
//
// Runs ONE model pass over (inbound email + draft reply) and returns an array
// of ActionItem objects. Reuses the same Ollama-compatible endpoint the live
// drafter uses (lib/drafting/router.ts:pickEndpoint -> lib/drafting/ollama.ts
// chat()), so local-route drafts extract on the local Qwen3 and cloud-route
// drafts extract on the cloud model — no new credentials, no new wire shape.
//
// NON-GATING by contract: this is fired AFTER draft-finalize has already
// persisted the body. Any failure (timeout, network, 5xx, unparseable output,
// no items) returns [] and logs a reason — it never throws and never affects
// the draft's body, status, or the finalize response. The hard 2s timeout
// bounds the added latency.

import type { Category } from '@/lib/classification/prompt';
import {
  ACTION_ITEM_SOURCES,
  ACTION_ITEM_TYPES,
  type ActionItem,
  type ActionItemSource,
  type ActionItemType,
} from '@/lib/types';
import { chat } from './ollama';
import { type DraftEndpoint, pickEndpoint } from './router';

// Hard ceiling on the extraction model call. The draft body is already
// persisted by the time this runs, so we'd rather drop the action items than
// extend the pipeline. 2s is generous for a small JSON-array completion on the
// local Qwen3 and well under the cloud SLA.
const EXTRACT_TIMEOUT_MS = 2_000;

// Cap the model's output length — action items are short phrases, not essays.
const EXTRACT_MAX_TOKENS = 512;

// Mirror the schema-side text cap (lib/schemas/drafts.ts:ACTION_ITEM_TEXT_MAX)
// so a model that over-quotes gets clamped here too, before persistence.
const TEXT_MAX = 500;

// Defensive upper bound so a runaway model can't hand us a 10k-element array.
const MAX_ITEMS = 50;

export interface ExtractActionItemsInput {
  draftId: number;
  draftBody: string;
  // The inbound message this draft is replying to.
  inbound: {
    from_addr: string | null;
    subject: string | null;
    body_text: string | null;
    classification_category: string | null;
    classification_confidence: number | null;
  };
  // Optional pre-resolved endpoint (used by tests / callers that already
  // routed). When omitted, the endpoint is derived from the inbound's
  // classification via pickEndpoint — the same route the drafter took.
  endpoint?: DraftEndpoint;
}

const TYPE_SET = new Set<string>(ACTION_ITEM_TYPES);
const SOURCE_SET = new Set<string>(ACTION_ITEM_SOURCES);

const SYSTEM_PROMPT = [
  'You extract concrete action items from a business email thread.',
  'You are given the inbound email and the proposed reply.',
  'Return ONLY a JSON array (no prose, no markdown fences). Each element is an object with EXACTLY these keys:',
  '  "text": string — the verbatim ask or commitment, one sentence.',
  `  "type": one of ${ACTION_ITEM_TYPES.map((t) => `"${t}"`).join(', ')}.`,
  '  "due_at": an ISO 8601 datetime string, or null if no date/deadline is mentioned.',
  '  "source": "inbound" if the counterparty owes the action, "outbound" if the operator (reply author) owes it.',
  '  "confidence": a number from 0 to 1.',
  'If there are no action items, return an empty array []. Do not invent items.',
].join('\n');

function buildUserPrompt(input: ExtractActionItemsInput): string {
  const { inbound, draftBody } = input;
  return [
    'INBOUND EMAIL',
    `From: ${inbound.from_addr ?? '(unknown)'}`,
    `Subject: ${inbound.subject ?? '(none)'}`,
    'Body:',
    inbound.body_text ?? '(empty)',
    '',
    'PROPOSED REPLY',
    draftBody,
  ].join('\n');
}

// Pull the first top-level JSON array out of a model response. Tolerates
// leading/trailing prose and ```json fences that some models emit despite the
// instruction not to.
function extractJsonArray(raw: string): unknown {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  const slice = raw.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

// Validate + clamp a single raw object into an ActionItem. Returns null for
// anything malformed (the caller drops it). Enums clamp to the canonical
// tuples; out-of-set values are dropped, not coerced to a default.
function coerceItem(raw: unknown): ActionItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.text !== 'string') return null;
  const text = o.text.trim().slice(0, TEXT_MAX);
  if (text.length === 0) return null;

  if (typeof o.type !== 'string' || !TYPE_SET.has(o.type)) return null;
  const type = o.type as ActionItemType;

  if (typeof o.source !== 'string' || !SOURCE_SET.has(o.source)) return null;
  const source = o.source as ActionItemSource;

  // due_at: accept a parseable date string, else null. Never throw.
  let due_at: string | null = null;
  if (typeof o.due_at === 'string' && o.due_at.trim().length > 0) {
    const parsed = new Date(o.due_at);
    due_at = Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  // confidence: clamp into [0,1]; non-numbers default to a neutral 0.5.
  let confidence = 0.5;
  if (typeof o.confidence === 'number' && Number.isFinite(o.confidence)) {
    confidence = Math.min(1, Math.max(0, o.confidence));
  }

  return { text, type, due_at, source, confidence };
}

export async function extractActionItems(input: ExtractActionItemsInput): Promise<ActionItem[]> {
  const endpoint =
    input.endpoint ??
    pickEndpoint(
      (input.inbound.classification_category as Category) ?? 'unknown',
      input.inbound.classification_confidence ?? 0,
    );

  try {
    const result = await chat({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      model: endpoint.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
      temperature: 0,
      max_tokens: EXTRACT_MAX_TOKENS,
      timeout_ms: EXTRACT_TIMEOUT_MS,
    });

    const parsed = extractJsonArray(result.body);
    if (!Array.isArray(parsed)) {
      console.warn(
        `extract_action_items_failed draft=${input.draftId} reason=parse (no JSON array in model output)`,
      );
      return [];
    }

    const items: ActionItem[] = [];
    for (const raw of parsed.slice(0, MAX_ITEMS)) {
      const item = coerceItem(raw);
      if (item) items.push(item);
    }
    return items;
  } catch (err) {
    // AbortSignal.timeout fires a DOMException named 'TimeoutError'.
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    const reason = isTimeout ? 'extract_action_items_timeout' : 'extract_action_items_failed';
    console.warn(
      `${reason} draft=${input.draftId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
