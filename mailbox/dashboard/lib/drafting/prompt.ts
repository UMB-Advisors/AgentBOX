// Canonical drafting prompt for MailBOX Zero (D-41).
//
// Single source of truth for both the local Qwen3 path and the Ollama Cloud
// escalation path. Consumed by the n8n 04-draft-sub workflow at runtime via
// POST /api/internal/draft-prompt. Keep this file diff-friendly — n8n cannot
// inline-edit the prompt.
//
// 02-07 cloud-path pivot (2026-04-30): both endpoints speak the Ollama
// /api/chat schema, so the same `messages` array works for either. Routing
// from category → endpoint+model lives in ./router.ts.

import type { Category } from '@/lib/classification/prompt';
import { CATEGORY_DESCRIPTIONS } from '@/lib/classification/prompt';
import type { PromptRuleScope } from '@/lib/types';
import { grammarForCategory } from './grammar-dispatch';
import type { PersonaContext } from './persona';

export const DRAFT_LOCAL_MODEL = 'qwen3:4b-ctx4k';
// Default Ollama Cloud escalation model. Swappable via OLLAMA_CLOUD_MODEL env.
export const DRAFT_CLOUD_MODEL_DEFAULT = 'gpt-oss:120b';
// Anthropic alt-cloud config-ready (not wired tonight; see `cost.ts` PRICING).
export const DRAFT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DraftPromptInput {
  // Denormalized fields from mailbox.drafts (populated at classify-time per
  // migration 003).
  from_addr: string;
  to_addr: string;
  subject: string;
  body_text: string;
  // Classification outcome.
  category: Category;
  confidence: number;
  // Persona — stubbed today; 02-06 fills the real fields without changing
  // this signature (D-41 anti-drift).
  persona: PersonaContext;
  // Optional future hooks. 02-05 (RAG) and 02-06 (full persona) fill these.
  thread_context?: ReadonlyArray<{ from_addr: string; body_text: string }>;
  rag_refs?: ReadonlyArray<{ source: string; excerpt: string }>;
  // STAQPRO-148 — operator-uploaded knowledge base snippets. Rendered as a
  // distinct prompt section ("Reference snippets from your knowledge base")
  // so the LLM treats them as authoritative policy content, not
  // conversational context. Same {source, excerpt} contract as rag_refs.
  kb_refs?: ReadonlyArray<{ source: string; excerpt: string }>;
  // STAQPRO-234 — auto-mined few-shot exemplars from mailbox.sent_history.
  // Distinct prompt slot ("Past replies you've sent for this kind of message")
  // so the LLM mimics the operator's past phrasings on this category.
  // Different semantics from rag_refs (vector-similar emails) and kb_refs
  // (operator-uploaded SOPs) → different surface, per Neo Architect.
  exemplar_refs?: ReadonlyArray<{ snippet: string; sent_at: string; subject?: string }>;
  // MBOX-130 — compact Google Calendar snapshot lines for `scheduling` drafts
  // (now → now+14d busy blocks). Lets the drafter propose concrete time slots
  // instead of "let me check my calendar." Privacy-gated upstream (LOCAL
  // always; CLOUD only when CALENDAR_CLOUD_ROUTE_ENABLED=1) — by the time the
  // lines reach here they've already passed the gate, so this is a pure render
  // slot. Empty → no calendar block (graceful degrade to no-calendar prompt).
  calendar_snapshot?: ReadonlyArray<string>;
  // MBOX-162 P4 follow-up — operator self-serve scheduling URL from
  // mailbox.operator_settings.booking_link. When set, the drafter offers it
  // verbatim on scheduling asks (see bookingLinkSystemBlock). Empty/undefined →
  // no scheduling-link instruction (every non-scheduling draft is unaffected).
  // It's a public booking page, intended to be shared, so it's egress-safe on
  // the cloud route.
  booking_link?: string;
  // MBOX-162 P5b — operator drafting guidelines (enabled mailbox.prompt_rules
  // for the draft's account). Rendered into the per-operator system prompt by
  // rulesSystemBlock. Empty/undefined → no guidelines block (byte-identical to
  // pre-P5b). Behavioral rules, so they persist across the redraft loop too.
  prompt_rules?: ReadonlyArray<{ scope: PromptRuleScope; rule: string }>;
}

// D-45 egress allowlist: when the assembled prompt is sent to a non-local
// endpoint (Ollama Cloud, Anthropic), only the fields below leave the
// appliance. The TypeScript return type is the contract — adding a field
// requires a deliberate edit to this interface.
export interface AssembledPrompt {
  messages: ReadonlyArray<ChatMessage>;
  // Soft cap to keep responses concise. Customers can tune later.
  max_tokens: number;
  // Temperature tuned for voice variation while preserving fidelity. Higher
  // than the classifier (which is 0 for reproducibility).
  temperature: number;
  // MBOX-120 — optional GBNF grammar for constrained decoding. Only set for
  // CONSTRAINED_CATEGORIES (reorder/scheduling) when CONSTRAINED_DECODING_ENABLED
  // is on; otherwise absent (the common case — spike default OFF). n8n forwards
  // it to the LLM call as `options.grammar`; only the llama.cpp local runtime
  // consumes it, real Ollama ignores it.
  grammar?: string;
}

const MAX_BODY_CHARS = 6000;
const MAX_THREAD_CHARS = 2000;

export function buildSystemPrompt(persona: PersonaContext): string {
  // Lean on the operator's voice. The `category` rules sit in the user prompt
  // because they're per-message; the system prompt is per-operator.
  //
  // The placeholder block is intentionally explicit + example-driven. The
  // 4B local model follows abstract instructions only ~50% of the time but
  // mimics concrete examples reliably. Worth the extra prompt tokens.
  const tone = persona.tone ?? 'concise, direct, warm';
  const signoff = persona.signoff ?? `— ${persona.operator_first_name ?? 'the operator'}`;
  // CPG-scrub Phase 1 (2026-05-08) — framing is now persona-derived, not
  // hardcoded. business_description comes from operator override set during
  // onboarding (e.g., "small-batch CPG operator", "B2B tech / dev tools
  // company"). Falls back to a generic descriptor when empty.
  const operatorName = persona.operator_first_name?.trim() || 'the operator';
  const operatorBrand = persona.operator_brand?.trim() || "the operator's business";
  const businessDesc = persona.business_description?.trim();
  const businessFraming = businessDesc
    ? `${operatorName} at ${operatorBrand} — a ${businessDesc}`
    : `${operatorName}, ${operatorBrand}`;
  return [
    `You are an email assistant for ${businessFraming}.`,
    `You draft replies in their voice: ${tone}.`,
    // MBOX-162 P5a — operator-tuned Style knobs. Each line only appears when the
    // operator set that knob in the /settings/tuning Style tab; an untuned
    // persona spreads nothing here, so output stays byte-identical to pre-P5a.
    ...voiceStyleLines(persona),
    `You are NOT a chatbot. The operator reviews every draft before it sends, so be specific, useful, and short.`,
    `Sign off with: ${signoff}`,
    `Never mention that you are an AI.`,
    '',
    'CRITICAL — when you do not know a fact, leave a bracketed placeholder.',
    'Do not invent prices, minimums, lead times, capabilities, or commitments.',
    'Use [confirm with operator: <what to confirm>] inline. Examples:',
    '',
    '  ✗ BAD:  "Our minimum order is 5,000 units and pricing starts at $1.20/unit."',
    '  ✓ GOOD: "Our minimum is [confirm with operator: MOQ for this product] and',
    '          pricing depends on volume — happy to share once we know your spec."',
    '',
    '  ✗ BAD:  "We will ship a replacement shipment today."',
    '  ✓ GOOD: "I will get a replacement shipment moving — [confirm with operator:',
    '          ship date once warehouse confirms]."',
    '',
    '  ✗ BAD:  "Our lead time is 3 weeks."  (when not stated by the customer)',
    '  ✓ GOOD: "Lead time is [confirm with operator: current production calendar]."',
    '',
    'If the customer gave you the fact in their email (e.g. "3-week lead time works for us"),',
    'restate it instead of using a placeholder — that is confirmation, not invention.',
  ].join('\n');
}

// MBOX-162 P5a (Tuning · Style tab) — translate the operator's voice knobs
// (resolved into PersonaContext from persona.statistical_markers) into concrete
// system-prompt directives. Returns one line per SET knob and nothing for unset
// ones, so an untuned persona contributes zero lines and the prompt is
// byte-identical to pre-P5a. Mirrors bookingLinkSystemBlock's append-when-set
// discipline. The 4B local model follows concrete instructions far better than
// abstract ones, so each line is imperative and specific.
const SENTENCE_LENGTH_DIRECTIVE: Record<'short' | 'medium' | 'long', string> = {
  short: 'Keep sentences short — roughly 5–12 words. Favor brevity over completeness.',
  medium: 'Use medium-length sentences — roughly 12–22 words.',
  long: 'Fuller sentences are fine — 22+ words when they read naturally.',
};
const EMOJI_DIRECTIVE: Record<'never' | 'sparingly' | 'match_customer', string> = {
  never: 'Do not use emoji.',
  sparingly: 'Use emoji sparingly — at most one, and only when it fits the tone.',
  match_customer:
    "Mirror the customer's emoji usage: use them only if they did, and keep it light.",
};

export function voiceStyleLines(persona: PersonaContext): string[] {
  const lines: string[] = [];

  if (persona.sentence_length_pref) {
    lines.push(SENTENCE_LENGTH_DIRECTIVE[persona.sentence_length_pref]);
  }

  const greeting = persona.greeting_pattern?.trim();
  if (greeting) {
    // {firstName} is the sender's first name; tell the model how to fill it so
    // it doesn't paste the literal placeholder.
    lines.push(
      `Open with a greeting in this style: "${greeting}" — replace {firstName} with the sender's first name, or drop it if unknown.`,
    );
  }

  if (persona.emoji_policy) {
    lines.push(EMOJI_DIRECTIVE[persona.emoji_policy]);
  }

  const jargon = (persona.jargon_allowlist ?? []).filter((t) => t.trim().length > 0);
  if (jargon.length > 0) {
    lines.push(
      `These domain terms are part of the operator's vocabulary — use them naturally when relevant: ${jargon.join(', ')}.`,
    );
  }

  return lines;
}

function categoryHint(category: Category, confidence: number): string {
  const desc = CATEGORY_DESCRIPTIONS[category];
  const conf = (confidence * 100).toFixed(0);
  return `Classification: ${category} (${conf}% confidence) — ${desc}`;
}

function threadBlock(input: DraftPromptInput): string {
  if (!input.thread_context || input.thread_context.length === 0) return '';
  // Truncate to keep within ctx budget.
  let used = 0;
  const lines: string[] = ['', '## Prior thread context'];
  for (const msg of input.thread_context) {
    const block = `From: ${msg.from_addr}\n${(msg.body_text ?? '').slice(0, 800)}`;
    if (used + block.length > MAX_THREAD_CHARS) break;
    lines.push(block, '---');
    used += block.length;
  }
  return lines.join('\n');
}

// STAQPRO-234 — re-allocate RAG slot when exemplars are present.
//
// Budget math (DR-18: 4096 ctx local, ~450 tokens of augmentation):
// - With exemplars:    1 exemplar (~600c / ~150t) + 2 RAG refs (~1200c / ~300t) = ~450t
// - Without exemplars: 3 RAG refs (~1800c / ~450t) — today's behavior unchanged
//
// Token budget is re-allocated WITHIN the existing slice; total context never
// grows. When `exemplar_refs` is empty (early-onboarding category with no
// sent_history yet, or fail-closed empty from getCategoryExemplars) we fall
// back to today's 3-ref RAG path so nothing regresses.
const RAG_REFS_CAP_DEFAULT = 3;
const RAG_REFS_CAP_WHEN_EXEMPLARS = 2;

function effectiveRagRefsCap(input: DraftPromptInput): number {
  return input.exemplar_refs && input.exemplar_refs.length > 0
    ? RAG_REFS_CAP_WHEN_EXEMPLARS
    : RAG_REFS_CAP_DEFAULT;
}

function ragBlock(input: DraftPromptInput): string {
  if (!input.rag_refs || input.rag_refs.length === 0) return '';
  const cap = effectiveRagRefsCap(input);
  const lines: string[] = ['', '## Reference snippets (use only if relevant)'];
  for (const ref of input.rag_refs.slice(0, cap)) {
    lines.push(`[${ref.source}] ${ref.excerpt.slice(0, 600)}`);
  }
  return lines.join('\n');
}

// STAQPRO-234 — past-replies block. Auto-mined from mailbox.sent_history.
// Section header explicitly says "you've sent" so the LLM mimics phrasing as
// the operator's voice rather than treating it as third-party reference.
// Cap at 1 exemplar by default (caller passes k=1) but accept up to 2 in
// case Phase 1 evals show the model benefits — same 600-char per-snippet
// cap as ragBlock + kbBlock.
function exemplarBlock(input: DraftPromptInput): string {
  if (!input.exemplar_refs || input.exemplar_refs.length === 0) return '';
  const lines: string[] = ['', "## Past replies you've sent for this kind of message"];
  // Cap at 2 max; the typical caller passes k=1.
  for (const ex of input.exemplar_refs.slice(0, 2)) {
    const date = ex.sent_at ? ` (${ex.sent_at.slice(0, 10)})` : '';
    const subj = ex.subject ? ` "${ex.subject.slice(0, 80)}"` : '';
    lines.push(`Reply${date}${subj}:`, ex.snippet.slice(0, 600));
  }
  return lines.join('\n');
}

// STAQPRO-148 — KB block. Distinct from ragBlock (which is conversational
// email-history context) — KB content is authoritative policy/SOP that the
// LLM should defer to over its priors. Section header explicitly says
// "your knowledge base" so the LLM weights these as ground truth.
//
// Per-chunk cap = 600 chars to match ragBlock and keep the combined
// rag+kb+body context under the Qwen3-4B 4096-token ctx ceiling. See the
// kbExcerptCharCap() comment in lib/rag/retrieve.ts for the full budget
// math (Linus pre-flight on commit 36d8949).
function kbBlock(input: DraftPromptInput): string {
  if (!input.kb_refs || input.kb_refs.length === 0) return '';
  const lines: string[] = ['', '## Reference snippets from your knowledge base'];
  for (const ref of input.kb_refs.slice(0, 3)) {
    lines.push(`[${ref.source}] ${ref.excerpt.slice(0, 600)}`);
  }
  return lines.join('\n');
}

// MBOX-130 — calendar snapshot block. Distinct from rag/kb/exemplar slots: it
// is the operator's own near-term availability, framed so the LLM proposes
// concrete times rather than punting ("let me check my calendar"). The lines
// are already privacy-gated (caller only passes them on the LOCAL route, or on
// CLOUD when CALENDAR_CLOUD_ROUTE_ENABLED=1). Cap at 25 lines so a packed
// 2-week calendar can't blow the local model's 4k ctx.
const CALENDAR_LINES_CAP = 25;
function calendarBlock(input: DraftPromptInput): string {
  if (!input.calendar_snapshot || input.calendar_snapshot.length === 0) return '';
  const lines: string[] = [
    '',
    '## Your calendar (next 2 weeks — busy blocks)',
    'These are times you are ALREADY booked. Propose 1-3 concrete open slots',
    'that avoid these when the email is asking to schedule. Do not reveal event',
    'titles to the recipient — only use them to find open time.',
  ];
  for (const line of input.calendar_snapshot.slice(0, CALENDAR_LINES_CAP)) {
    lines.push(`- ${line}`);
  }
  return lines.join('\n');
}

export function buildUserPrompt(input: DraftPromptInput): string {
  const safeBody = (input.body_text ?? '').slice(0, MAX_BODY_CHARS);
  return [
    // /no_think — Qwen3 directive that suppresses <think>...</think> blocks
    // in the response. Cloud models (gpt-oss, etc.) don't recognize it and
    // will ignore the leading line. normalizeDraftBody() strips any residual
    // blocks defensively.
    '/no_think',
    categoryHint(input.category, input.confidence),
    '',
    "Draft a reply to this email. Match the operator's voice from the system prompt.",
    '',
    '## Inbound email',
    `From: ${input.from_addr}`,
    `To: ${input.to_addr}`,
    `Subject: ${input.subject}`,
    '',
    safeBody,
    threadBlock(input),
    // STAQPRO-234 — exemplars FIRST so the LLM anchors on the operator's own
    // voice from prior replies before reading the conversational RAG / KB
    // reference snippets. Empty → fall through to today's RAG-only behavior.
    exemplarBlock(input),
    ragBlock(input),
    kbBlock(input),
    // MBOX-130 — calendar availability for `scheduling` drafts. Empty for every
    // other category and whenever the snapshot was unavailable/gated.
    calendarBlock(input),
    '',
    '## Output format',
    'Return ONLY the body of the reply email. No subject line, no headers, no quoted original. Plain text only.',
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n');
}

// MBOX-162 P4 follow-up — appended to the per-operator system prompt when a
// booking link is configured. Behavioral rule (not per-message), so it lives in
// the system message: it persists across the redraft loop too, since
// assembleRedraftMessages reuses assemblePrompt. Empty/whitespace → '' (no
// block) so a fresh appliance with no link set is byte-identical to before.
export function bookingLinkSystemBlock(bookingLink?: string): string {
  const url = (bookingLink ?? '').trim();
  if (!url) return '';
  return [
    '',
    'SCHEDULING LINK — the operator has a self-serve booking page. If (and only',
    'if) the sender is asking to set up a call, demo, or meeting, offer this link',
    `and paste the URL exactly as written, unmodified: ${url}`,
    'Do not include it in replies that are not about scheduling.',
  ].join('\n');
}

// MBOX-162 P5b (Tuning · Guidelines tab) — render the operator's enabled
// drafting rules into a clearly demarcated system-prompt block. One bullet per
// rule, scope mapped to an imperative verb. Empty/undefined → '' so a box with
// no rules is byte-identical to pre-P5b (same discipline as bookingLinkSystemBlock).
//
// The block explicitly subordinates the guidelines to the anti-hallucination
// rule in buildSystemPrompt: operator rules tune voice/behavior, they never
// license inventing facts.
const RULE_SCOPE_VERB: Record<PromptRuleScope, string> = {
  always: 'Always',
  prefer: 'Prefer to',
  avoid: 'Avoid',
  never: 'Never',
};

export function rulesSystemBlock(
  rules?: ReadonlyArray<{ scope: PromptRuleScope; rule: string }>,
): string {
  if (!rules || rules.length === 0) return '';
  const bullets = rules
    .filter((r) => r.rule.trim().length > 0)
    .map((r) => `- ${RULE_SCOPE_VERB[r.scope]}: ${r.rule.trim()}`);
  if (bullets.length === 0) return '';
  return [
    '',
    'OPERATOR GUIDELINES — the operator set these drafting rules. Follow them, but',
    'they do NOT override the rule above about not inventing facts (use the',
    '[confirm with operator: …] placeholder when unsure, guideline or not):',
    ...bullets,
  ].join('\n');
}

// Assemble the final messages payload. This is the function that crosses the
// egress boundary (D-45) — its return type defines what's allowed to leave.
export function assemblePrompt(input: DraftPromptInput): AssembledPrompt {
  const messages: ReadonlyArray<ChatMessage> = [
    {
      role: 'system',
      content:
        buildSystemPrompt(input.persona) +
        bookingLinkSystemBlock(input.booking_link) +
        rulesSystemBlock(input.prompt_rules),
    },
    { role: 'user', content: buildUserPrompt(input) },
  ];
  // MBOX-120 — attach a GBNF grammar only for constrained categories when the
  // flag is on; null on every normal path so the field stays absent.
  const grammar = grammarForCategory(input.category);
  return {
    messages,
    max_tokens: 600,
    // 0.7 = enough variation to avoid robot-feel; low enough to stay grounded.
    temperature: 0.7,
    ...(grammar !== null && { grammar }),
  };
}
