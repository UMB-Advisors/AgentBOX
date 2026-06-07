-- Migration 027 — MBOX-285: chat history persistence (parent epic MBOX-282 "Launch App").
-- WHAT: Two new mailbox tables for the local-model chat surface (/dashboard/chat,
--       built by MBOX-287). mailbox.chat_conversations is one row per chat
--       session; mailbox.chat_messages is one row per turn (user / assistant /
--       system), FK'd to its conversation with ON DELETE CASCADE. Assistant
--       turns carry rag_context_refs + rag_retrieval_reason mirroring the
--       drafts/sent_history pattern (migration 013 / STAQPRO-191) so an
--       augmented answer records which corpus messages informed it.
-- WHY:  MBOX-285 is the persistence foundation for the launch-app epic. Streaming
--       (MBOX-284) and the chat route (MBOX-287) build on this data layer. History
--       lives only on the appliance (NFR-7) and is visible only behind the existing
--       dashboard auth (FR-26) — no schema-level cloud surface; the only writers are
--       internal dashboard routes inside the docker network.
-- ROLLBACK: DROP TABLE mailbox.chat_messages; DROP TABLE mailbox.chat_conversations;
--           remove the internal routes (dashboard/app/api/internal/chat/...),
--           the queries (dashboard/lib/queries-chat.ts), the zod schemas
--           (dashboard/lib/schemas/chat.ts), and the CHAT_MESSAGE_ROLES constant
--           in dashboard/lib/types.ts. No data carried elsewhere (chat history is
--           self-contained — not archived into sent_history or state_transitions).

CREATE TABLE IF NOT EXISTS mailbox.chat_conversations (
  id          SERIAL PRIMARY KEY,
  -- Optional human/auto-generated label for the session. NULL until set by the
  -- chat route (e.g. first-message summary); the UI falls back to a timestamp.
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Bumped by the message-insert query helper on each new turn so the
  -- conversation list can sort by recency without scanning chat_messages.
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mailbox.chat_messages (
  id               SERIAL PRIMARY KEY,
  conversation_id  INTEGER NOT NULL
                     REFERENCES mailbox.chat_conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,
  content          TEXT NOT NULL,
  -- Model that produced an assistant turn (e.g. 'qwen3-4b-ctx4k'). NULL for
  -- user/system turns. Mirrors the drafts.model convention (the route/source is
  -- always local per DR-53 — chat is strictly on-device, no cloud fallback — so
  -- no draft_source-style column is needed here).
  model            TEXT,
  -- Token accounting for assistant turns (NULL for user/system). Same shape as
  -- drafts.input_tokens / output_tokens.
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  -- Qdrant point UUIDs that augmented this (assistant) turn, mirroring
  -- drafts.rag_context_refs / sent_history.rag_context_refs (migration 013 /
  -- STAQPRO-191). Empty array [] = retrieval gated / unavailable / no hits —
  -- same semantics as the drafts column. Truth at answer-assembly time; do NOT
  -- mutate after insert (point-in-time snapshot, per CLAUDE.md rag_context_refs
  -- field semantics).
  rag_context_refs    JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Why retrieval returned what it did: 'none' | 'ok' | 'no_hits' |
  -- 'embed_unavailable' | 'qdrant_unavailable' | 'below_floor' (the chat
  -- relevance-floor outcome from MBOX-283). Free TEXT at the DB layer — the
  -- chat retrieval endpoint owns the value set — defaulting to 'none' exactly
  -- like drafts.rag_retrieval_reason (migration 013).
  rag_retrieval_reason TEXT NOT NULL DEFAULT 'none',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Closed enum. Keep in lockstep with CHAT_MESSAGE_ROLES in
  -- dashboard/lib/types.ts; the schema-invariants test asserts this.
  CONSTRAINT chat_messages_role_check CHECK (
    role IN ('user', 'assistant', 'system')
  ),

  -- Content is always present (a turn with no text is meaningless). length()
  -- guard mirrors the draft_feedback free_text non-blank pattern (migration 023).
  CONSTRAINT chat_messages_content_not_blank CHECK (length(trim(content)) > 0)
);

-- Primary read pattern: load a conversation's messages in turn order
-- (/dashboard/chat reload + container-restart history replay, AC "history
-- survives reload and restart").
CREATE INDEX IF NOT EXISTS chat_messages_conversation_id_created_at_idx
  ON mailbox.chat_messages(conversation_id, created_at);
