import { describe, expect, it } from 'vitest';
import { parseChatSseFrame } from '@/lib/chat/client-stream';

// MBOX-287 — browser-side SSE frame parser. Mirrors the server frame contract
// in lib/chat/sse.ts. Pure string→event parsing; the fetch-stream transport is
// exercised on-box (real SSE flush through Caddy is flagged for M1/M2).

describe('parseChatSseFrame', () => {
  it('parses a token frame', () => {
    expect(parseChatSseFrame('event: token\ndata: {"delta":"Hi"}')).toEqual({
      type: 'token',
      delta: 'Hi',
    });
  });

  it('parses a saved frame with sources', () => {
    const frame =
      'event: saved\ndata: {"assistant_message_id":7,"sources":[{"point_id":"p1","message_id":"m1","excerpt":"x","score":0.8}],"rag_retrieval_reason":"ok"}';
    expect(parseChatSseFrame(frame)).toMatchObject({
      type: 'saved',
      assistant_message_id: 7,
      rag_retrieval_reason: 'ok',
    });
  });

  it('parses an error frame', () => {
    expect(
      parseChatSseFrame(
        'event: error\ndata: {"code":"local_unavailable","detail":"down","runtime":"llama-cpp"}',
      ),
    ).toEqual({ type: 'error', code: 'local_unavailable', detail: 'down', runtime: 'llama-cpp' });
  });

  it('returns null on a frame missing event or data', () => {
    expect(parseChatSseFrame('data: {"delta":"x"}')).toBeNull();
    expect(parseChatSseFrame('event: token')).toBeNull();
  });

  it('returns null on malformed json', () => {
    expect(parseChatSseFrame('event: token\ndata: {not json}')).toBeNull();
  });
});
