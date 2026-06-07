// dashboard/lib/mail/providers/__tests__/microsoft.test.ts
//
// MBOX-358 (P2) — MicrosoftGraphProvider pure logic: normalize (nested Graph
// JSON + flattened variants), native conversationId threading, Graph 429
// Retry-After parsing, capabilities, and the not-yet-implemented transport
// boundary. Mirrors imap.test.ts; threading is the EASY case here (native id).

import { describe, expect, it } from 'vitest';
import { GraphNotImplementedYet, MicrosoftGraphProvider, providerFor, providerForKind } from '..';

const graph = new MicrosoftGraphProvider();

describe('MicrosoftGraphProvider.normalize', () => {
  it('maps a raw Graph message (nested from/toRecipients/body/headers)', () => {
    const msg = graph.normalize({
      id: 'AAMkAGI2_native_id',
      conversationId: 'AAQkAGI2_conv',
      internetMessageId: '<abc@contoso.com>',
      subject: 'Re: Q3 numbers',
      from: { emailAddress: { name: 'Pat', address: 'pat@contoso.com' } },
      toRecipients: [{ emailAddress: { name: 'Op', address: 'op@startup.com' } }],
      body: { contentType: 'html', content: '<p>see attached</p>' },
      bodyPreview: 'see attached',
      receivedDateTime: '2026-05-29T12:00:00Z',
      internetMessageHeaders: [
        { name: 'In-Reply-To', value: '<m1@contoso.com>' },
        { name: 'References', value: '<m0@contoso.com> <m1@contoso.com>' },
      ],
    });
    expect(msg.provider_message_id).toBe('AAMkAGI2_native_id'); // native id wins as dedup key
    expect(msg.thread_id).toBe('AAQkAGI2_conv'); // conversationId passthrough
    expect(msg.from_addr).toBe('pat@contoso.com');
    expect(msg.to_addr).toBe('op@startup.com');
    expect(msg.subject).toBe('Re: Q3 numbers');
    expect(msg.body).toBe('<p>see attached</p>'); // full body content preferred over preview
    expect(msg.in_reply_to).toBe('<m1@contoso.com>');
    expect(msg.references).toBe('<m0@contoso.com> <m1@contoso.com>');
    expect(msg.received_at).toBe('2026-05-29T12:00:00Z');
    expect(msg.direction).toBe('inbound');
  });

  it('accepts flattened snake_case keys (n8n pre-extracted payload)', () => {
    const msg = graph.normalize({
      message_id: 'flat-id',
      thread_id: 'flat-conv',
      from_addr: 'a@x.com',
      to_addr: 'b@y.com',
      body: 'plain text body',
      received_at: '2026-05-29T00:00:00Z',
    });
    expect(msg.provider_message_id).toBe('flat-id');
    expect(msg.thread_id).toBe('flat-conv');
    expect(msg.from_addr).toBe('a@x.com');
    expect(msg.to_addr).toBe('b@y.com');
    expect(msg.body).toBe('plain text body');
    expect(msg.in_reply_to).toBeNull();
    expect(msg.references).toBeNull();
  });

  it('falls back to bodyPreview when body content is absent', () => {
    const msg = graph.normalize({ id: 'x', bodyPreview: 'preview only' });
    expect(msg.body).toBe('preview only');
  });

  it('tolerates a missing conversationId (thread_id null) and empty input', () => {
    expect(graph.normalize({ id: 'no-conv' }).thread_id).toBeNull();
    const empty = graph.normalize({});
    expect(empty.provider_message_id).toBe('');
    expect(empty.from_addr).toBe('');
    expect(empty.direction).toBe('inbound');
  });
});

describe('MicrosoftGraphProvider.normalizeThreadId (native conversationId)', () => {
  it('passes the conversationId through unchanged (no synthesis)', () => {
    const m = graph.normalize({ id: 'r2', conversationId: 'CONV-XYZ' });
    expect(graph.normalizeThreadId(m)).toBe('CONV-XYZ');
  });

  it('all messages in a conversation share the native thread_id', () => {
    const a = graph.normalize({ id: 'm-a', conversationId: 'CONV-1' });
    const b = graph.normalize({ id: 'm-b', conversationId: 'CONV-1' });
    expect(a.thread_id).toBe(b.thread_id);
  });
});

describe('MicrosoftGraphProvider.parseRateLimit (Graph 429 Retry-After)', () => {
  it('parses Retry-After delta-seconds from a structured error', () => {
    const { until } = graph.parseRateLimit({ status: 429, headers: { 'retry-after': '30' } });
    expect(until).not.toBeNull();
    // ~30s out (allow scheduling slack)
    expect(until!.getTime()).toBeGreaterThan(Date.now() + 25_000);
    expect(until!.getTime()).toBeLessThan(Date.now() + 35_000);
  });

  it('reads Retry-After off a fetch-style Headers object on .response', () => {
    const headers = new Headers({ 'retry-after': '12' });
    const { until } = graph.parseRateLimit({ response: { status: 429, headers } });
    expect(until).not.toBeNull();
    expect(until!.getTime()).toBeGreaterThan(Date.now());
  });

  it('detects a textual 429 / throttle with an embedded Retry-After', () => {
    const { until } = graph.parseRateLimit(
      new Error('429 TooManyRequests — Retry-After: 5 (ApplicationThrottled)'),
    );
    expect(until).not.toBeNull();
    expect(until!.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns a conservative future cooldown for a 429 with no hint', () => {
    const { until } = graph.parseRateLimit({ statusCode: 429 });
    expect(until).not.toBeNull();
    expect(until!.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns null for a non-throttle error', () => {
    expect(graph.parseRateLimit({ status: 404 }).until).toBeNull();
    expect(graph.parseRateLimit('ErrorItemNotFound').until).toBeNull();
    expect(graph.parseRateLimit('connection reset').until).toBeNull();
  });
});

describe('MicrosoftGraphProvider capabilities + boundaries', () => {
  it('declares native threading, poll-only, outlook quote strategy', () => {
    expect(graph.capabilities).toEqual({
      nativeThreading: true,
      push: false,
      quoteStrategy: 'outlook',
    });
  });

  it('transport I/O throws GraphNotImplementedYet (pending DR-56)', () => {
    const acct = { id: 1, provider: 'microsoft' as const, provider_config: {} };
    expect(() => graph.listNew(acct, null)).toThrow(GraphNotImplementedYet);
    expect(() =>
      graph.send(acct, {
        thread_id: null,
        in_reply_to: null,
        to_addr: 'a@b.c',
        subject: 's',
        body: 'b',
      }),
    ).toThrow(GraphNotImplementedYet);
    expect(() => graph.backfillSent(acct, { lookbackHours: 24 })).toThrow(GraphNotImplementedYet);
  });
});

describe('providerFor factory — microsoft arm (P2)', () => {
  it('returns a MicrosoftGraphProvider for microsoft', () => {
    expect(providerForKind('microsoft')).toBeInstanceOf(MicrosoftGraphProvider);
    expect(providerFor({ provider: 'microsoft' }).kind).toBe('microsoft');
  });
});
