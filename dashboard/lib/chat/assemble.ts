// dashboard/lib/chat/assemble.ts
//
// MBOX-287 — pure message assembly for the /dashboard/chat orchestration
// (epic MBOX-282). Given the conversation's prior turns (MBOX-285), the new
// user message, and the retrieval result (MBOX-283), build the
// `OllamaChatMessage[]` handed to the local-model streaming relay (MBOX-284).
//
// Kept side-effect-free (no DB, no fetch, no React) so the assembly rules —
// system prompt, the DR-56 retrieval-gating, history ordering — are unit-tested
// hermetically. The route layer (app/api/internal/chat/send) does the IO and
// calls into here.
//
// LOCAL-ONLY (DR-53): nothing here references a cloud provider; the messages
// produced are consumed only by streamLocalChat, which is local-only by
// construction.

import type { OllamaChatMessage } from '@umb-advisors/llm';
import type { ApplianceStatsContext } from '@/lib/queries-chat-stats';
import type { ChatRetrievalRef, ChatRetrievalResult } from '@/lib/rag/chat-retrieve';
import type { ChatMessage } from '@/lib/types';

// Roles the local model accepts. chat_messages also persists 'system' turns in
// principle, but the live chat flow only writes user/assistant turns; a stored
// 'system' role would still map cleanly here.
const MODEL_ROLES = new Set(['system', 'user', 'assistant']);

// Base persona for the chat surface. Deliberately conservative about grounding:
// the DR-56 / SM-74 invariant is that the model must NOT make document/source
// claims when retrieval did not clear the relevance floor. We encode that as
// two distinct system prompts (grounded vs plain) selected by the retrieval
// reason, rather than trusting the model to infer it from an empty context
// block.
//
// MBOX-307 — the persona now describes the appliance accurately so the model
// stops confabulating a (partly false) self-description. The box DOES ingest,
// embed, classify, draft, and store the operator's email locally — earlier
// prompting let the 4B claim "email content is not stored on the device," which
// is the opposite of what the appliance does. The factual capability statement
// + the always-present appliance-stats block (renderApplianceStatsBlock,
// injected by the orchestrator) are what let it answer operational/aggregate
// questions from real numbers instead of guessing.
const BASE_PERSONA =
  'You are the on-device assistant for a MailBox One appliance. You run locally ' +
  'on the customer’s own hardware; no email ever leaves the box. The appliance ' +
  'ingests the operator’s email, classifies it, drafts replies for approval, and ' +
  'stores that email and its embeddings locally so it can be searched and ' +
  'referenced — all on this device. A live appliance-statistics block is ' +
  'provided to you below; you MAY answer questions about volumes, senders, ' +
  'recipients, categories, and queue state directly from those numbers. Answer ' +
  'the operator’s questions directly and concisely. Never invent statistics, ' +
  'capabilities, or claims about how this appliance stores or processes data: ' +
  'use the stats block for operational questions and the past-message excerpts ' +
  '(when provided) for questions about specific correspondence. If neither the ' +
  'stats block nor any retrieved excerpt covers the question, say so plainly and ' +
  'suggest the Status page or the approval Queue rather than guessing.';

// Appended only when retrieval cleared the floor (reason === 'ok'). Tells the
// model it MAY ground its answer in the provided excerpts and cite them.
const GROUNDED_SUFFIX =
  ' Some of the operator’s own past email messages are provided below as ' +
  'context because they appear relevant to the question. Use them when they help, ' +
  'and make clear when an answer comes from that correspondence. If the context ' +
  'does not actually answer the question, say so rather than guessing.';

// Appended on every non-'ok' reason (below_floor | no_hits | embed_unavailable |
// qdrant_unavailable | empty_query). SM-74 guard in prompt form: no past-message
// excerpts are attached, and the model must not claim it has any. It MAY still
// answer operational questions from the appliance-stats block (which is always
// present, independent of retrieval) — the constraint is specifically about not
// fabricating quotes/citations from email it did not receive this turn.
const PLAIN_SUFFIX =
  ' No relevant past messages were retrieved for this question. Do NOT claim to ' +
  'be quoting or citing the operator’s email — you have no message excerpts for ' +
  'this turn. You may still answer operational questions from the appliance-' +
  'statistics block above. If the question is about specific correspondence and ' +
  'is not covered by the stats, say you don’t have that on hand rather than ' +
  'guessing.';

// Per-snippet excerpt cap when rendering retrieved context into the prompt.
// retrieveForChat already truncates to RAG_RETRIEVE_EXCERPT_CHARS; this is a
// belt-and-suspenders bound so a misconfigured retriever can't blow the
// local-model context window (DR-18, 4096 ctx on Qwen3-4B).
const CONTEXT_EXCERPT_CAP = 600;

/** Build the system prompt for this turn, gated on the retrieval reason. */
export function buildSystemPrompt(reason: ChatRetrievalResult['reason']): string {
  return reason === 'ok' ? BASE_PERSONA + GROUNDED_SUFFIX : BASE_PERSONA + PLAIN_SUFFIX;
}

/**
 * Render the appliance-stats context into a compact text block (MBOX-307).
 * Pure — the orchestrator computes the stats (DB IO) and passes them in.
 *
 * Kept tight for the 4096-ctx local model (DR-18): totals, ≤5 senders, ≤5
 * recipients, the category breakdown on one line, and the queue counts — about
 * a dozen lines. Empty tables render as zeros (handled upstream in
 * getApplianceStatsContext), so the block is always present and never lies by
 * omission. Returns null only when stats are unavailable (the orchestrator
 * passed null because the aggregate query failed), so the model is never told
 * "0 emails" when the truth is "couldn't read".
 */
export function renderApplianceStatsBlock(stats: ApplianceStatsContext | null): string | null {
  if (!stats) return null;

  const lines: string[] = ['Appliance stats (live, from this device):'];

  const { inbound } = stats;
  lines.push(
    `- Emails ingested: ${inbound.total} total ` +
      `(last 24h: ${inbound.last_24h}, 7d: ${inbound.last_7d}, 30d: ${inbound.last_30d})`,
  );
  if (inbound.earliest_received_at || inbound.latest_received_at) {
    lines.push(
      `- Date range: ${inbound.earliest_received_at ?? 'n/a'} to ${inbound.latest_received_at ?? 'n/a'}`,
    );
  }

  if (stats.categories.length > 0) {
    const cats = stats.categories.map((c) => `${c.category} ${c.count}`).join(', ');
    lines.push(`- By category: ${cats}`);
  }

  if (stats.top_senders.length > 0) {
    const senders = stats.top_senders.map((s) => `${s.addr} (${s.count})`).join(', ');
    lines.push(`- Top inbound senders: ${senders}`);
  }

  if (stats.top_recipients.length > 0) {
    const recips = stats.top_recipients.map((r) => `${r.addr} (${r.count})`).join(', ');
    lines.push(`- Top outbound recipients: ${recips}`);
  }

  const { queue } = stats;
  lines.push(
    `- Draft queue: ${queue.pending} pending, ${queue.approved} approved, ` +
      `${queue.sent} sent, ${queue.rejected} rejected`,
  );

  return lines.join('\n');
}

/**
 * Render retrieved refs into a single context block. Returns null when there is
 * nothing to attach (no refs OR reason !== 'ok'), so the caller never appends
 * an empty/grounding-implying block on a below-floor turn (SM-74).
 */
export function buildContextBlock(result: ChatRetrievalResult): string | null {
  if (result.reason !== 'ok' || result.refs.length === 0) return null;
  const lines = result.refs.map((ref: ChatRetrievalRef, i: number) => {
    const excerpt = (ref.excerpt ?? '').trim().slice(0, CONTEXT_EXCERPT_CAP);
    return `[${i + 1}] ${excerpt}`;
  });
  return `Relevant past messages:\n${lines.join('\n\n')}`;
}

/**
 * Map persisted history rows to model messages, in order, dropping any role the
 * model doesn't accept and any empty-content row (a never-finalized assistant
 * stub would be empty — never send that as priming).
 */
export function historyToModelMessages(history: readonly ChatMessage[]): OllamaChatMessage[] {
  const out: OllamaChatMessage[] = [];
  for (const m of history) {
    if (!MODEL_ROLES.has(m.role)) continue;
    const content = (m.content ?? '').trim();
    if (content.length === 0) continue;
    out.push({ role: m.role as OllamaChatMessage['role'], content: m.content });
  }
  return out;
}

export interface AssembleInput {
  /** Prior turns for this conversation, oldest-first (getConversationMessages). */
  history: readonly ChatMessage[];
  /** The new user message text for this turn. */
  userContent: string;
  /** Retrieval outcome for userContent (retrieveForChat / MBOX-283). */
  retrieval: ChatRetrievalResult;
  /**
   * Live appliance stats for operational/aggregate questions (MBOX-307).
   * Computed by the orchestrator (DB IO) and passed in here so the assembler
   * stays pure. Always injected when present, independent of the retrieval
   * reason. null when the aggregate query failed (block is then omitted rather
   * than rendering misleading zeros). Optional so existing callers / tests that
   * don't supply it simply get no stats block.
   */
  stats?: ApplianceStatsContext | null;
}

/**
 * Assemble the full ordered message array for the local model:
 *
 *   [ system(gated) , (appliance-stats system block)? , ...priorHistory ,
 *     (RAG context block as a system turn)? , user ]
 *
 * The appliance-stats block (MBOX-307) is injected as a `system` message right
 * after the persona, independent of the retrieval reason — so operational
 * questions ("how many ingested," "who do we email most") are always grounded
 * in real numbers even when message retrieval falls below the floor. It is
 * distinct from the RAG context block, which carries specific past-message
 * excerpts and is still gated on reason === 'ok' (SM-74 / DR-56). The retrieved
 * context is injected as a `system` message immediately before the user turn so
 * it reads as out-of-band grounding, not as something the operator typed.
 */
export function assembleChatMessages(input: AssembleInput): OllamaChatMessage[] {
  const messages: OllamaChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(input.retrieval.reason) },
  ];

  // Appliance-stats facts block — always present (regardless of retrieval
  // reason) so the model can answer operational/aggregate questions from real
  // numbers. null when the orchestrator couldn't read the stats.
  const statsBlock = renderApplianceStatsBlock(input.stats ?? null);
  if (statsBlock) {
    messages.push({ role: 'system', content: statsBlock });
  }

  messages.push(...historyToModelMessages(input.history));

  const context = buildContextBlock(input.retrieval);
  if (context) {
    messages.push({ role: 'system', content: context });
  }

  messages.push({ role: 'user', content: input.userContent });
  return messages;
}
