import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import type { ChatConversation, ChatMessage, ChatMessageRole } from '@/lib/types';

// MBOX-285: read/write helpers for chat-history persistence (parent epic
// MBOX-282). Conversations + per-turn messages live in the mailbox schema and
// never leave the appliance (NFR-7). Assistant turns carry rag_context_refs
// (Qdrant point UUIDs) mirroring the drafts/sent_history pattern so MBOX-287
// can show which corpus messages informed an augmented answer.

const CONVERSATION_COLS = ['id', 'account_id', 'title', 'created_at', 'updated_at'] as const;

const MESSAGE_COLS = [
  'id',
  'conversation_id',
  'role',
  'content',
  'model',
  'input_tokens',
  'output_tokens',
  'rag_context_refs',
  'rag_retrieval_reason',
  'created_at',
] as const;

// Creates a chat session. title is optional (NULL until the route sets one).
// MBOX-400 (MBOX-162 V7): accountId stamps which inbox this session is asking
// about — it scopes the Ask-the-KB retrieval. Omitted → the column DEFAULT (the
// default account, migration 033) applies, so single-account callers are
// unchanged.
export async function createConversation(
  title: string | null = null,
  accountId?: number,
): Promise<ChatConversation> {
  const db = getKysely();
  const row = await db
    .insertInto('chat_conversations')
    .values(accountId !== undefined ? { title, account_id: accountId } : { title })
    .returning(CONVERSATION_COLS)
    .executeTakeFirstOrThrow();
  return row as ChatConversation;
}

// Lists conversations most-recently-updated first — the chat sidebar's read
// pattern. No pagination in v1 (single-operator appliance, low volume).
// MBOX-400: accountId optionally scopes the sidebar to one inbox; omitted lists
// every account's sessions (single-account default + the "all inboxes" view).
export async function listConversations(accountId?: number): Promise<ChatConversation[]> {
  const db = getKysely();
  let q = db.selectFrom('chat_conversations').select(CONVERSATION_COLS);
  if (accountId !== undefined) q = q.where('account_id', '=', accountId);
  const rows = await q.orderBy('updated_at', 'desc').execute();
  return rows as ChatConversation[];
}

// MBOX-400 (MBOX-162 V7) — resolve the account a chat session belongs to, so
// runChatTurn can hard-filter Ask-the-KB retrieval to that inbox. Returns null
// only when the conversation id doesn't exist (account_id is NOT NULL).
export async function getConversationAccountId(conversationId: number): Promise<number | null> {
  const db = getKysely();
  const row = await db
    .selectFrom('chat_conversations')
    .select('account_id')
    .where('id', '=', conversationId)
    .executeTakeFirst();
  return row ? row.account_id : null;
}

export interface AppendMessageInput {
  conversation_id: number;
  role: ChatMessageRole;
  content: string;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  // Qdrant point UUIDs (RFC 4122) — assistant turns only; [] otherwise.
  rag_context_refs?: string[];
  rag_retrieval_reason?: string;
}

// Appends a turn and bumps the parent conversation's updated_at so the sidebar
// re-sorts. Done in a single transaction so the bump can't drift from the
// insert. rag_context_refs is written as ::jsonb exactly like the drafts path
// (app/api/internal/draft-prompt) keeping the array UUID-only and round-trip
// stable.
export async function appendMessage(input: AppendMessageInput): Promise<ChatMessage> {
  const db = getKysely();
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('chat_messages')
      .values({
        conversation_id: input.conversation_id,
        role: input.role,
        content: input.content,
        model: input.model ?? null,
        input_tokens: input.input_tokens ?? null,
        output_tokens: input.output_tokens ?? null,
        rag_context_refs: sql`${JSON.stringify(input.rag_context_refs ?? [])}::jsonb`,
        rag_retrieval_reason: input.rag_retrieval_reason ?? 'none',
      })
      .returning(MESSAGE_COLS)
      .executeTakeFirstOrThrow();

    await trx
      .updateTable('chat_conversations')
      .set({ updated_at: sql<string>`NOW()` })
      .where('id', '=', input.conversation_id)
      .execute();

    return row as ChatMessage;
  });
}

// Loads a conversation's turns in insertion order — the /dashboard/chat reload
// + container-restart replay path (AC "history survives reload and restart").
// Served by the chat_messages_conversation_id_created_at_idx index.
export async function getConversationMessages(conversationId: number): Promise<ChatMessage[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom('chat_messages')
    .select(MESSAGE_COLS)
    .where('conversation_id', '=', conversationId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows as ChatMessage[];
}
