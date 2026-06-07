// dashboard/lib/chat/sse.ts
//
// MBOX-287 — SSE serialization for the chat-send orchestration's ChatTurnEvent
// stream. Sibling of lib/llm/sse.ts (which frames the raw StreamEvent union for
// the bare streaming endpoint); this one additionally frames the orchestration's
// terminal `saved` event. Same frame contract the browser consumes:
//
//   event: token
//   data: {"delta":"Hi"}
//
//   event: done
//   data: {"model":"qwen3-4b-ctx4k","done_reason":"stop","prompt_eval_count":412,"eval_count":27}
//
//   event: saved
//   data: {"assistant_message_id":42,"sources":[...],"rag_retrieval_reason":"ok"}
//
//   event: error
//   data: {"code":"local_unavailable","detail":"...","runtime":"llama-cpp"}
//
// A clean turn ends with `done` then `saved`; a failed turn ends with `error`.
// Either terminal frame closes the stream. The named `event:` lets the chat
// client attach a listener per type.

import type { RuntimeKind } from '@umb-advisors/llm';
import type { ChatTurnEvent } from '@/lib/chat/orchestrate';

/** Serialize one ChatTurnEvent to an SSE frame string. */
export function toChatSseFrame(event: ChatTurnEvent): string {
  const { type, ...rest } = event;
  return `event: ${type}\ndata: ${JSON.stringify(rest)}\n\n`;
}

/**
 * Wrap a ChatTurnEvent async generator into a ReadableStream of SSE bytes.
 * Streaming (rather than buffering) is what gives the browser true
 * token-by-token delivery; `saved` and `error` are terminal and close the
 * stream cleanly.
 */
export function chatSseStream(
  events: AsyncGenerator<ChatTurnEvent, void, unknown>,
  runtime: RuntimeKind,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(toChatSseFrame(value)));
        // 'saved' and 'error' are terminal — drain the generator and close so
        // the browser sees a clean end rather than a hang.
        if (value.type === 'saved' || value.type === 'error') {
          await events.return?.(undefined);
          controller.close();
        }
      } catch (err) {
        // An unexpected throw inside the orchestration becomes a terminal error
        // frame rather than a dropped connection.
        controller.enqueue(
          encoder.encode(
            toChatSseFrame({
              type: 'error',
              code: 'upstream_malformed',
              detail: err instanceof Error ? err.message : String(err),
              runtime,
            }),
          ),
        );
        controller.close();
      }
    },
    async cancel() {
      // Browser disconnected — tear down the upstream relay.
      await events.return?.(undefined);
    },
  });
}

/** Standard headers for the chat SSE response (mirrors lib/llm/sse.ts). */
export const CHAT_SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // Disable proxy buffering (Caddy/nginx) so frames flush immediately.
  'x-accel-buffering': 'no',
};
