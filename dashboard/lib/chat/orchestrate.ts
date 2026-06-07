// dashboard/lib/chat/orchestrate.ts
//
// MBOX-287 — the chat-send orchestration that ties retrieval (MBOX-283),
// streaming (MBOX-284), and persistence (MBOX-285) into one server-side turn
// (epic MBOX-282). The /dashboard/chat page consumes ONE endpoint
// (POST /api/internal/chat/send); this module is the logic behind it, exposed
// as an async generator of chat-turn events so the route can serialize them to
// SSE and the test suite can drive it with mocked dependencies.
//
// Per-turn sequence:
//   1. persist the user message            (MBOX-285 appendMessage)
//   2. retrieve corpus context for the query (MBOX-283 retrieveForChat)
//   3. assemble system + history + context + user  (assemble.ts)
//   4. stream the LOCAL model               (MBOX-284 streamLocalChat) — relay
//      each `token` event straight through; accumulate text + final metadata
//   5. on `done`, persist the assistant message with model / token counts /
//      rag_context_refs (the floor-cleared point UUIDs) and the retrieval
//      reason, then emit a terminal `saved` event carrying the assistant
//      message id + the resolved sources so the client can render attribution
//   6. on `error`, relay it and DO NOT persist a (truncated) assistant turn —
//      a half-streamed answer is not history.
//
// LOCAL-ONLY (DR-53 / SM-73): the only model seam is streamLocalChat, which is
// local-only by construction. There is no cloud branch and no field that could
// introduce one.
//
// Testability: retrieve / stream / persist are all injected via ChatSendDeps,
// each defaulting to the real implementation. Tests pass fakes (a canned
// retrieval result, a scripted StreamEvent generator, in-memory persistence)
// and assert on the emitted ChatTurnEvent sequence + what got persisted —
// hermetic, no DB and no on-box llama.cpp.

import type { OllamaChatMessage, RuntimeKind, StreamEvent } from '@umb-advisors/llm';
import {
  readLlamaCppBaseUrl,
  readLlamaCppModel,
  readOllamaBaseUrl,
  readRuntimeKind,
  streamLocalChat,
} from '@umb-advisors/llm';
import { assembleChatMessages, buildSystemPrompt } from '@/lib/chat/assemble';
import {
  appendMessage as appendMessageImpl,
  getConversationAccountId as getConversationAccountIdImpl,
  getConversationMessages as getConversationMessagesImpl,
} from '@/lib/queries-chat';
import {
  type ApplianceStatsContext,
  getApplianceStatsContext as getApplianceStatsContextImpl,
} from '@/lib/queries-chat-stats';
import {
  type ChatRetrievalResult,
  retrieveForChat as retrieveForChatImpl,
} from '@/lib/rag/chat-retrieve';
import type { ChatMessage } from '@/lib/types';

// ── Public event contract relayed to the browser ───────────────────────────
//
// `token` / `done` / `error` are re-emitted verbatim from the streaming layer
// (same wire shape MBOX-284 already documents). `saved` is added by this
// orchestration after the assistant turn is persisted, so the client can swap
// its optimistic streamed bubble for the durable row + sources without a second
// round-trip. A terminal frame is always exactly one of { 'done' followed by
// 'saved', or 'error' }.

/** The point-UUID-resolved source the UI renders under an augmented answer. */
export interface ChatSourceRef {
  point_id: string;
  message_id: string;
  excerpt: string;
  score: number;
}

export type ChatTurnEvent =
  | { type: 'token'; delta: string }
  | {
      type: 'done';
      model: string;
      done_reason?: 'stop' | 'length';
      prompt_eval_count?: number;
      eval_count?: number;
    }
  | {
      // Emitted after the assistant turn is persisted (post-'done'). Carries the
      // durable message id and the retrieval-gated sources (empty unless
      // reason === 'ok', honoring SM-74).
      type: 'saved';
      assistant_message_id: number;
      sources: ChatSourceRef[];
      rag_retrieval_reason: ChatRetrievalResult['reason'];
    }
  | {
      type: 'error';
      code: 'local_unavailable' | 'upstream_malformed';
      detail: string;
      runtime: RuntimeKind;
    };

export interface ChatSendInput {
  conversationId: number;
  content: string;
  // When true, the user turn is assumed already persisted by the caller (the
  // route does this first so a bad conversation_id returns a clean 400 before
  // any SSE stream opens). The generator then skips the user-turn insert and
  // proceeds straight to retrieval. Default false (self-contained — the test
  // path drives the full sequence).
  skipUserPersist?: boolean;
}

// Injectable seams — default to the real implementations. `signal` lets a
// disconnected browser tear down the upstream stream.
export interface ChatSendDeps {
  signal?: AbortSignal;
  retrieveForChat?: (query: string, accountId?: number) => Promise<ChatRetrievalResult>;
  getConversationMessages?: (conversationId: number) => Promise<ChatMessage[]>;
  // MBOX-400 (MBOX-162 V7) — resolves the conversation's inbox so retrieval is
  // scoped to that account's history (no cross-inbox leak on a multi-account
  // box). Defaults to the real query; tests inject a fixed account id.
  getConversationAccountId?: (conversationId: number) => Promise<number | null>;
  appendMessage?: typeof appendMessageImpl;
  // MBOX-307 — live appliance stats injected into the chat context for
  // operational/aggregate questions. Defaults to the real aggregate query;
  // tests pass a canned object. A throw here degrades to no stats block (the
  // turn is not aborted) — see runChatTurn.
  getApplianceStats?: () => Promise<ApplianceStatsContext>;
  // Returns the normalized StreamEvent generator for the assembled messages.
  // Defaults to the real local-runtime relay (streamLocalChat) wired to the
  // on-device runtime config.
  streamChat?: (messages: OllamaChatMessage[]) => AsyncGenerator<StreamEvent, void, unknown>;
}

// Default streaming seam: resolve the LOCAL runtime config and relay through
// streamLocalChat. LOCAL-ONLY — mirrors app/api/internal/llm/api/chat/stream.
function defaultStreamChat(
  messages: OllamaChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent, void, unknown> {
  const runtime = readRuntimeKind();
  const baseUrl = runtime === 'llama-cpp' ? readLlamaCppBaseUrl() : readOllamaBaseUrl();
  const model = runtime === 'llama-cpp' ? readLlamaCppModel() : 'qwen3:4b-ctx4k';
  return streamLocalChat(runtime, { messages }, { baseUrl, model, signal });
}

/**
 * Run one chat turn. Yields ChatTurnEvents in order; the route serializes them
 * to SSE. The generator persists the user message up front and the assistant
 * message after a clean 'done'. On 'error' it relays the failure and persists
 * nothing further (a partial answer is not durable history).
 */
export async function* runChatTurn(
  input: ChatSendInput,
  deps: ChatSendDeps = {},
): AsyncGenerator<ChatTurnEvent, void, unknown> {
  const retrieveForChat = deps.retrieveForChat ?? retrieveForChatImpl;
  const getConversationAccountId = deps.getConversationAccountId ?? getConversationAccountIdImpl;
  const getConversationMessages = deps.getConversationMessages ?? getConversationMessagesImpl;
  const appendMessage = deps.appendMessage ?? appendMessageImpl;
  const getApplianceStats = deps.getApplianceStats ?? getApplianceStatsContextImpl;
  const streamChat =
    deps.streamChat ??
    ((messages: OllamaChatMessage[]) => defaultStreamChat(messages, deps.signal));

  const content = input.content.trim();

  // 1. Persist the user turn first so history survives even if the model call
  //    fails midway (the operator's question is never lost). Skipped when the
  //    route already did it (clean 400-on-bad-conversation_id path).
  if (!input.skipUserPersist) {
    await appendMessage({
      conversation_id: input.conversationId,
      role: 'user',
      content,
    });
  }

  // 2. Retrieve corpus context, hard-scoped to this conversation's inbox so a
  //    multi-account box never bleeds one inbox's history into another's answer
  //    (MBOX-400). account_id is NOT NULL on chat_conversations, so null only
  //    means "conversation missing" — fall back to corpus-wide rather than
  //    aborting (the model call would fail on a bad id downstream anyway).
  //    retrieveForChat never throws — a non-'ok' reason degrades to plain chat
  //    (SM-74), it does not abort the turn.
  const accountId = await getConversationAccountId(input.conversationId);
  const retrieval = await retrieveForChat(content, accountId ?? undefined);

  // 2b. Compute the live appliance-stats block (MBOX-307) so operational/
  //     aggregate questions are answered from real numbers. A failure here is
  //     non-fatal: degrade to no stats block (null) rather than aborting the
  //     turn — chat must keep working if the aggregate query hiccups.
  let stats: ApplianceStatsContext | null = null;
  try {
    stats = await getApplianceStats();
  } catch (error) {
    console.error('runChatTurn — appliance-stats query failed (degrading to no block):', error);
  }

  // 3. Load prior history (now includes the just-persisted user turn; drop it
  //    from priming since assembleChatMessages appends the user turn itself).
  const fullHistory = await getConversationMessages(input.conversationId);
  const priorHistory = dropTrailingUserTurn(fullHistory, content);

  const messages = assembleChatMessages({
    history: priorHistory,
    userContent: content,
    retrieval,
    stats,
  });

  // 4. Stream the local model, relaying tokens and capturing the answer + the
  //    terminal metadata for persistence.
  let answer = '';
  let doneMeta: {
    model: string;
    done_reason?: 'stop' | 'length';
    prompt_eval_count?: number;
    eval_count?: number;
  } | null = null;

  for await (const ev of streamChat(messages)) {
    if (ev.type === 'token') {
      answer += ev.delta;
      yield { type: 'token', delta: ev.delta };
    } else if (ev.type === 'done') {
      doneMeta = {
        model: ev.model,
        done_reason: ev.done_reason,
        prompt_eval_count: ev.prompt_eval_count,
        eval_count: ev.eval_count,
      };
      yield { type: 'done', ...doneMeta };
    } else {
      // error — relay and stop. Do NOT persist a partial assistant turn.
      yield { type: 'error', code: ev.code, detail: ev.detail, runtime: ev.runtime };
      return;
    }
  }

  // If the stream ended without a terminal 'done' or 'error' (a malformed
  // upstream that just closed), treat it as upstream_malformed rather than
  // silently persisting whatever partial text accumulated.
  if (!doneMeta) {
    yield {
      type: 'error',
      code: 'upstream_malformed',
      detail: 'stream ended without a terminal done event',
      runtime: readRuntimeKind(),
    };
    return;
  }

  // 5. Persist the assistant turn. rag_context_refs carries ONLY the
  //    floor-cleared point UUIDs (empty unless reason === 'ok'), mirroring the
  //    drafts path; rag_retrieval_reason records the gate outcome for telemetry.
  const refs = retrieval.reason === 'ok' ? retrieval.refs : [];
  const pointIds = refs.map((r) => r.point_id);

  const saved = await appendMessage({
    conversation_id: input.conversationId,
    role: 'assistant',
    content: answer,
    model: doneMeta.model,
    input_tokens: doneMeta.prompt_eval_count ?? null,
    output_tokens: doneMeta.eval_count ?? null,
    rag_context_refs: pointIds,
    rag_retrieval_reason: retrieval.reason,
  });

  yield {
    type: 'saved',
    assistant_message_id: saved.id,
    sources: refs.map((r) => ({
      point_id: r.point_id,
      message_id: r.message_id,
      excerpt: r.excerpt,
      score: r.score,
    })),
    rag_retrieval_reason: retrieval.reason,
  };
}

// getConversationMessages returns the full conversation including the user turn
// we just persisted. assembleChatMessages appends the user turn itself, so we
// strip exactly one trailing matching user row to avoid duplicating it. Matching
// on (role==='user' && trimmed content equal) is sufficient for the single
// in-flight turn; we only ever drop the last row.
function dropTrailingUserTurn(history: ChatMessage[], content: string): ChatMessage[] {
  const last = history[history.length - 1];
  if (last && last.role === 'user' && (last.content ?? '').trim() === content) {
    return history.slice(0, -1);
  }
  return history;
}

// Re-export for the route's convenience / discoverability.
export { buildSystemPrompt };
