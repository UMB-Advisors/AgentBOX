'use client';

import { MessageSquarePlus, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DraftingIndicator } from '@/components/DraftingIndicator';
import { apiUrl } from '@/lib/api';
import { streamChatSend } from '@/lib/chat/client-stream';
import type { ChatSourceRef } from '@/lib/chat/orchestrate';
import type { DraftingFlag } from '@/lib/drafting-flag';
import type { AccountRef, ChatConversation, ChatMessage } from '@/lib/types';

// MBOX-287 — the /dashboard/chat client surface (epic MBOX-282). Owns the live
// turn loop: it POSTs to /api/internal/chat/send and renders streamed tokens
// incrementally, shows retrieval-gated sources under an augmented answer (DR-56
// / SM-74 — nothing rendered when retrieval didn't clear the floor), persists
// + replays history (MBOX-285), and surfaces the honest in-flight drafting flag
// (MBOX-288 / DR-54) while a turn waits behind the drafts-priority pipeline.
//
// LOCAL-ONLY (DR-53): the only endpoint this calls for inference is the
// local-only send route. There is no cloud affordance in this UI.

// A message as the UI tracks it: persisted rows plus the in-flight streaming
// assistant bubble (id is null until the server's 'saved' event lands).
interface UiMessage {
  id: number | null;
  role: ChatMessage['role'];
  content: string;
  sources: ChatSourceRef[];
  // Retrieval gate outcome for assistant turns (drives the "no sources" note vs
  // the sources list). 'none' for user turns / pre-stream.
  reason: string;
  // True while tokens are still arriving for this bubble.
  streaming: boolean;
  // Set when the turn failed (local box unavailable etc.) — rendered distinctly
  // from a normal empty answer (SM-73).
  error?: { code: string; detail: string };
}

interface Props {
  conversations: ChatConversation[];
  activeConversationId: number | null;
  initialMessages: ChatMessage[];
  // MBOX-400 (MBOX-162 V7) — connected inboxes for the account picker, and the
  // SSR-resolved inbox a NEW conversation is asked against (seeded from ?account=
  // → default account). Single-account boxes pass one account and the picker
  // stays hidden. Retrieval is scoped to the conversation's account server-side.
  accounts: AccountRef[];
  selectedAccountId: number | null;
}

function toUiMessage(m: ChatMessage): UiMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    // Persisted assistant turns carry rag_context_refs (point UUIDs) but the
    // resolved excerpts aren't reloaded on SSR — we render the count via the
    // reason. Live turns get full sources from the 'saved' event.
    sources: [],
    reason: m.rag_retrieval_reason ?? 'none',
    streaming: false,
  };
}

export function ChatClient({
  conversations,
  activeConversationId,
  initialMessages,
  accounts,
  selectedAccountId,
}: Props) {
  // MBOX-400 — show the inbox picker + per-conversation account badge only on a
  // multi-account box; single-account stays uncluttered (mirrors the V3 queue).
  const showAccount = accounts.length > 1;
  const accountLabel = (id: number): string => {
    const a = accounts.find((x) => x.id === id);
    return a ? a.display_label?.trim() || a.email_address : `#${id}`;
  };
  // Preserve the chosen inbox when starting a new conversation.
  const newChatHref =
    selectedAccountId != null ? apiUrl(`/chat?account=${selectedAccountId}`) : apiUrl('/chat');
  const [messages, setMessages] = useState<UiMessage[]>(() => initialMessages.map(toUiMessage));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [draftingFlag, setDraftingFlag] = useState<DraftingFlag>({ drafting: false });

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll to the newest content as tokens stream in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every message change
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // MBOX-288 — poll the honest in-flight flag only while a turn is in progress.
  // The flag reflects ACTUAL pipeline state (drafts/state_transitions), so when
  // a chat turn stalls behind a draft (DR-54) the operator sees the true
  // "Drafting a reply…" rather than a guess; otherwise "Thinking…".
  useEffect(() => {
    if (!sending) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(apiUrl('/api/system/drafting-flag'), { cache: 'no-store' });
        if (!res.ok) return;
        const flag = (await res.json()) as DraftingFlag;
        if (!cancelled) setDraftingFlag(flag);
      } catch {
        // Network blip — keep the last flag; the indicator stays honest because
        // a stale 'drafting:true' still reflects a real in-flight draft.
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sending]);

  // Ensure there's a conversation to append to; create one lazily on first send
  // so opening /dashboard/chat with no ?c= doesn't spawn an empty conversation.
  const ensureConversation = useCallback(async (): Promise<number> => {
    if (activeConversationId) return activeConversationId;
    const res = await fetch(apiUrl('/api/internal/chat/conversations'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // MBOX-400 — stamp the chosen inbox so retrieval is scoped to it. Omitted
      // → the column DEFAULT (default account) on a single-account box.
      body: JSON.stringify(selectedAccountId != null ? { account_id: selectedAccountId } : {}),
    });
    if (!res.ok) throw new Error(`could not start conversation (HTTP ${res.status})`);
    const conv = (await res.json()) as ChatConversation;
    // Navigate so the URL carries the conversation id (reload-safe) — full
    // navigation re-runs the server page with the new ?c=.
    window.location.assign(apiUrl(`/chat?c=${conv.id}`));
    return conv.id;
  }, [activeConversationId, selectedAccountId]);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || sending) return;

    // No active conversation → create one (navigates away; the message will be
    // sent on the freshly-loaded page). Guard the common case first.
    if (!activeConversationId) {
      setSending(true);
      try {
        await ensureConversation();
      } catch (err) {
        setSending(false);
        setMessages((prev) => [
          ...prev,
          {
            id: null,
            role: 'assistant',
            content: '',
            sources: [],
            reason: 'none',
            streaming: false,
            error: {
              code: 'no_conversation',
              detail: err instanceof Error ? err.message : 'unknown',
            },
          },
        ]);
      }
      return;
    }

    setInput('');
    setSending(true);

    // Optimistic user bubble + an empty streaming assistant bubble.
    setMessages((prev) => [
      ...prev,
      { id: null, role: 'user', content, sources: [], reason: 'none', streaming: false },
      { id: null, role: 'assistant', content: '', sources: [], reason: 'none', streaming: true },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for await (const ev of streamChatSend(
        { conversation_id: activeConversationId, content },
        controller.signal,
      )) {
        if (ev.type === 'token') {
          setMessages((prev) =>
            patchLastAssistant(prev, (m) => ({ ...m, content: m.content + ev.delta })),
          );
        } else if (ev.type === 'done') {
          // Metadata only; the durable swap happens on 'saved'.
        } else if (ev.type === 'saved') {
          setMessages((prev) =>
            patchLastAssistant(prev, (m) => ({
              ...m,
              id: ev.assistant_message_id,
              sources: ev.sources,
              reason: ev.rag_retrieval_reason,
              streaming: false,
            })),
          );
        } else if (ev.type === 'error') {
          setMessages((prev) =>
            patchLastAssistant(prev, (m) => ({
              ...m,
              streaming: false,
              error: { code: ev.code, detail: ev.detail },
            })),
          );
        }
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [input, sending, activeConversationId, ensureConversation]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full min-h-0">
      {/* Conversation sidebar (MBOX-285 listConversations) */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border-subtle bg-bg-panel md:flex">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle px-3">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">
            Conversations
          </span>
          <a
            href={newChatHref}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-ink-muted hover:bg-bg-deep hover:text-ink"
            aria-label="New conversation"
          >
            <MessageSquarePlus size={15} />
          </a>
        </div>
        {/* MBOX-400 — inbox picker (multi-account only). Navigates with ?account=
            so the choice is reload-safe and scopes the NEXT new conversation. */}
        {showAccount && (
          <label className="block shrink-0 border-b border-border-subtle px-3 py-2">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-dim">
              Ask about inbox
            </span>
            <select
              value={selectedAccountId ?? ''}
              onChange={(e) => {
                window.location.assign(apiUrl(`/chat?account=${e.target.value}`));
              }}
              className="w-full rounded border border-border bg-bg-deep px-2 py-1 font-sans text-xs text-ink"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_label?.trim() || a.email_address}
                </option>
              ))}
            </select>
          </label>
        )}
        <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-2">
          {conversations.length === 0 && (
            <p className="px-2 py-3 font-sans text-xs text-ink-dim">No conversations yet.</p>
          )}
          {conversations.map((c) => (
            <a
              key={c.id}
              href={apiUrl(`/chat?c=${c.id}`)}
              aria-current={c.id === activeConversationId ? 'page' : undefined}
              className={`truncate rounded px-2 py-1.5 font-sans text-sm transition-colors ${
                c.id === activeConversationId
                  ? 'bg-bg-deep text-ink'
                  : 'text-ink-muted hover:bg-bg-deep hover:text-ink'
              }`}
            >
              {showAccount && (
                <span className="mr-1.5 rounded-full border border-border bg-bg-deep px-1.5 py-0.5 font-mono text-[9px] tracking-wider text-ink-dim">
                  {accountLabel(c.account_id)}
                </span>
              )}
              {c.title?.trim() || `Conversation ${c.id}`}
            </a>
          ))}
        </nav>
      </aside>

      {/* Main chat column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-border-subtle bg-bg-panel px-4">
          <h1 className="font-sans text-sm font-semibold tracking-tight text-ink">Chat</h1>
          <span className="ml-2 rounded-full border border-border bg-bg-deep px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-ink-dim">
            local
          </span>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {messages.length === 0 && (
              <p className="py-12 text-center font-sans text-sm text-ink-dim">
                Ask your appliance anything. Answers come from your on-device model, grounded in
                your own email when relevant.
              </p>
            )}
            {messages.map((m, i) => (
              <MessageBubble key={m.id ?? `live-${i}`} message={m} />
            ))}
            {sending && (
              <div className="mx-auto w-full max-w-2xl">
                <DraftingIndicator flag={draftingFlag} />
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t border-border-subtle bg-bg-panel px-4 py-3">
          <div className="mx-auto flex max-w-2xl items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Message your appliance…"
              disabled={sending}
              className="min-h-[40px] flex-1 resize-none rounded border border-border bg-bg-deep px-3 py-2 font-sans text-sm text-ink placeholder:text-ink-dim focus:border-ink-dim focus:outline-none disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || input.trim().length === 0}
              aria-label="Send message"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-accent-orange text-bg-deep transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Apply a patch to the last assistant message (the in-flight streaming bubble).
function patchLastAssistant(
  messages: UiMessage[],
  patch: (m: UiMessage) => UiMessage,
): UiMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      const next = messages.slice();
      next[i] = patch(next[i]);
      return next;
    }
  }
  return messages;
}

function MessageBubble({ message }: { message: UiMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 font-sans text-sm leading-relaxed ${
          isUser
            ? 'bg-accent-orange/15 text-ink'
            : 'border border-border-subtle bg-bg-panel text-ink'
        }`}
      >
        {message.error ? (
          <span className="text-accent-red">
            {message.error.code === 'local_unavailable'
              ? 'The on-device model is unavailable right now. Nothing was sent off the appliance — try again shortly.'
              : `Chat error: ${message.error.detail}`}
          </span>
        ) : message.content.length > 0 ? (
          message.content
        ) : message.streaming ? (
          <span className="text-ink-dim">…</span>
        ) : (
          <span className="text-ink-dim">(no response)</span>
        )}
      </div>
      {!isUser && !message.error && <ChatSources message={message} />}
    </div>
  );
}

// Retrieval-gated sources display (DR-56 / SM-74). Renders the source excerpts
// ONLY when retrieval cleared the floor (reason === 'ok' and there are refs).
// On any other reason — below_floor, no_hits, embed/qdrant unavailable — render
// NOTHING (no "document" framing), because the answer made no grounding claim.
function ChatSources({ message }: { message: UiMessage }) {
  if (message.reason !== 'ok' || message.sources.length === 0) return null;
  return (
    <div className="max-w-[85%] space-y-1.5">
      <p className="font-sans text-[11px] uppercase tracking-wider text-ink-dim">
        Grounded in {message.sources.length} message{message.sources.length === 1 ? '' : 's'}
      </p>
      <ul className="space-y-1.5">
        {message.sources.map((s) => (
          <li
            key={s.point_id}
            className="rounded-sm border border-border-subtle bg-bg-deep p-2 font-sans text-xs leading-relaxed text-ink-muted"
          >
            {s.excerpt.trim().slice(0, 240)}
            {s.excerpt.trim().length > 240 ? '…' : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
