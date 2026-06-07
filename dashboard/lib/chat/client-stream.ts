// dashboard/lib/chat/client-stream.ts
//
// MBOX-287 — browser-side consumer of the /api/internal/chat/send SSE stream.
//
// The send endpoint is a POST (it carries the conversation_id + content body),
// so the native EventSource API — which only does GET — can't be used. Instead
// we POST with fetch and read response.body as a stream, parsing SSE frames
// ourselves. This mirrors the server frame contract in lib/chat/sse.ts:
//
//   event: token | done | saved | error
//   data: <json>
//
// Frames are separated by a blank line ("\n\n"). We buffer partial chunks
// across reads and dispatch each complete frame as a typed ChatTurnEvent.
//
// Pure parsing/transport — no React — so it stays unit-testable and the
// component just consumes the async iterator.

import { apiUrl } from '@/lib/api';
import type { ChatTurnEvent } from '@/lib/chat/orchestrate';

/** Parse one raw SSE frame ("event: x\ndata: {...}") into a ChatTurnEvent. */
export function parseChatSseFrame(frame: string): ChatTurnEvent | null {
  let eventType = '';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) eventType = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (!eventType || dataLines.length === 0) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(dataLines.join('\n'));
  } catch {
    return null;
  }
  return { type: eventType, ...payload } as ChatTurnEvent;
}

/**
 * POST a chat turn and yield ChatTurnEvents as they stream in. The caller
 * relays `token` deltas into the streaming bubble, swaps to the durable row on
 * `saved`, and surfaces `error` distinctly (SM-73: a local-unavailable error is
 * not an empty answer). `signal` lets the UI abort an in-flight turn.
 */
export async function* streamChatSend(
  body: { conversation_id: number; content: string },
  signal?: AbortSignal,
): AsyncGenerator<ChatTurnEvent, void, unknown> {
  const res = await fetch(apiUrl('/api/internal/chat/send'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  // A non-2xx (e.g. 400 bad conversation_id, validation_failed) is a JSON body,
  // not a stream. Surface it as a synthetic error event so the caller has one
  // failure path.
  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) detail = j.error;
    } catch {
      // non-JSON body — keep the status-code detail.
    }
    yield { type: 'error', code: 'upstream_malformed', detail, runtime: 'llama-cpp' };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Dispatch every complete frame (terminated by a blank line); keep the
      // trailing partial in the buffer for the next read.
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const ev = parseChatSseFrame(frame);
        if (ev) yield ev;
        sep = buffer.indexOf('\n\n');
      }
    }
    // Flush any trailing frame that wasn't blank-line terminated.
    const tail = buffer.trim();
    if (tail) {
      const ev = parseChatSseFrame(tail);
      if (ev) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}
