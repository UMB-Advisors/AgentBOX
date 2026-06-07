// dashboard/lib/redraft/client-stream.ts
//
// P3 (MBOX-162) — browser-side consumer of the /api/internal/draft-redraft SSE
// stream. The endpoint is a POST (it carries draft_id + current_body +
// instruction), so EventSource (GET-only) can't be used; we POST with fetch and
// parse SSE frames ourselves. Frame contract is the @umb-advisors/llm
// StreamEvent union (token | done | error), same `event: x\ndata: <json>`
// framing the chat client parses.

import type { StreamEvent } from '@umb-advisors/llm';
import { apiUrl } from '@/lib/api';

/** Parse one raw SSE frame ("event: x\ndata: {...}") into a StreamEvent. */
export function parseRedraftSseFrame(frame: string): StreamEvent | null {
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
  return { type: eventType, ...payload } as StreamEvent;
}

export interface RedraftRequest {
  draft_id: number;
  current_body: string;
  instruction: string;
}

/**
 * POST a redraft turn and yield StreamEvents as they stream in. The caller
 * relays `token` deltas into the result bubble and surfaces `error` distinctly
 * (a local-unavailable error is not an empty rewrite). `signal` aborts in-flight.
 */
export async function* streamRedraft(
  body: RedraftRequest,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent, void, unknown> {
  const res = await fetch(apiUrl('/api/internal/draft-redraft'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  // A non-2xx (403 disabled, 404/409/422, validation) is a JSON body, not a
  // stream. Surface it as a synthetic error event so the caller has one path.
  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) detail = j.error;
    } catch {
      // non-JSON body — keep the status-code detail.
    }
    yield { type: 'error', code: 'upstream_malformed', detail, runtime: 'ollama' };
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
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const ev = parseRedraftSseFrame(frame);
        if (ev) yield ev;
        sep = buffer.indexOf('\n\n');
      }
    }
    const tail = buffer.trim();
    if (tail) {
      const ev = parseRedraftSseFrame(tail);
      if (ev) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}
