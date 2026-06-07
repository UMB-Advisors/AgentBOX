import { z } from 'zod';
import { CHAT_MESSAGE_ROLES } from '@/lib/types';

// MBOX-285 — schemas for the internal chat-history persistence routes
// (POST /api/internal/chat/conversations, POST /api/internal/chat/messages,
// GET .../messages). Called from the dashboard's own /dashboard/chat route
// (MBOX-287) inside the docker network — not from n8n. History is local-only
// (NFR-7) and auth-gated by Caddy on the public surface (FR-26).

// POST /api/internal/chat/conversations — start a session. Title is optional;
// the chat route may backfill it from a first-message summary later.
export const chatConversationCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).nullish(),
  // MBOX-400 (MBOX-162 V7) — which inbox this session asks about. Optional:
  // omitted → the chat_conversations.account_id DEFAULT (default account).
  account_id: z.coerce.number().int().positive().optional(),
});

export type ChatConversationCreate = z.infer<typeof chatConversationCreateSchema>;

// POST /api/internal/chat/messages — append a turn. model/tokens/rag_* are
// assistant-turn metadata; user/system turns omit them. rag_context_refs is an
// array of Qdrant point UUIDs (RFC 4122) mirroring the drafts pattern — the
// route persists it verbatim; the relevance-floor outcome lands in
// rag_retrieval_reason (MBOX-283).
export const chatMessageCreateSchema = z.object({
  conversation_id: z.coerce.number().int().positive(),
  role: z.enum(CHAT_MESSAGE_ROLES),
  content: z.string().trim().min(1, 'content (non-empty string) required'),
  model: z.string().trim().min(1).nullish(),
  input_tokens: z.coerce.number().int().nonnegative().nullish(),
  output_tokens: z.coerce.number().int().nonnegative().nullish(),
  rag_context_refs: z.array(z.string().uuid()).default([]),
  rag_retrieval_reason: z.string().trim().min(1).default('none'),
});

export type ChatMessageCreate = z.infer<typeof chatMessageCreateSchema>;

// GET /api/internal/chat/messages?conversation_id=N — load a conversation's
// turns in order.
export const chatMessagesQuerySchema = z.object({
  conversation_id: z.coerce.number().int().positive(),
});

export type ChatMessagesQuery = z.infer<typeof chatMessagesQuerySchema>;

// MBOX-283 — POST /api/internal/chat/retrieve. Query-scoped top-k retrieval
// over the email_messages Qdrant collection to ground a chat answer. The
// route embeds `query` and returns the above-floor hits + their point UUIDs;
// MBOX-287 renders them as sources and persists the UUIDs into
// chat_messages.rag_context_refs (MBOX-285). 2000-char cap keeps the embed
// input bounded (embed.ts truncates further to EMBED_MAX_CHARS regardless).
export const chatRetrieveSchema = z.object({
  query: z.string().trim().min(1, 'query (non-empty string) required').max(2000),
  // MBOX-400 (MBOX-162 V7) — hard-scope retrieval to one inbox's history.
  // Optional: omitted → corpus-wide (single-account / eval harness).
  account_id: z.coerce.number().int().positive().optional(),
});

export type ChatRetrieve = z.infer<typeof chatRetrieveSchema>;

// MBOX-287 — POST /api/internal/chat/send. The single orchestration endpoint
// the /dashboard/chat page consumes: it persists the user turn, retrieves
// corpus context (MBOX-283), assembles the prompt, streams the LOCAL model
// (MBOX-284, returned to the browser as SSE), then persists the assistant turn
// (MBOX-285). Body is just the conversation id + the new user message; the
// model, retrieval, and persistence are all server-side (no cloud field — chat
// is strictly local, DR-53). 4000-char cap bounds a single chat turn; retrieval
// itself caps the embed input further (chatRetrieveSchema, 2000).
export const chatSendSchema = z.object({
  conversation_id: z.coerce.number().int().positive(),
  content: z.string().trim().min(1, 'content (non-empty string) required').max(4000),
});

export type ChatSend = z.infer<typeof chatSendSchema>;
