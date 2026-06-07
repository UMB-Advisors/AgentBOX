import { describe, expect, it } from 'vitest';
import {
  callFetchHistory,
  extractReplyPairs,
  type FetchHistoryThread,
  type GmailMessage,
  parseGmailMessage,
} from '@/lib/onboarding/gmail-history-backfill';

// STAQPRO-193 — pure-function tests for the backfill orchestrator. The DB
// upsert helpers are exercised through the smoke test (which mocks fetch
// + asserts the run-counts shape end-to-end without a Postgres).

const OPERATOR = 'dustin@heronlabsinc.com';

function gmailMessage(opts: {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject?: string;
  body?: string;
  // ms since epoch
  internalDate?: number;
  inReplyTo?: string;
  references?: string;
  rfc822MessageId?: string;
}): GmailMessage {
  const headers: Array<{ name: string; value: string }> = [
    { name: 'From', value: opts.from },
    { name: 'To', value: opts.to },
  ];
  if (opts.subject !== undefined) headers.push({ name: 'Subject', value: opts.subject });
  if (opts.inReplyTo) headers.push({ name: 'In-Reply-To', value: opts.inReplyTo });
  if (opts.references) headers.push({ name: 'References', value: opts.references });
  if (opts.rfc822MessageId) headers.push({ name: 'Message-ID', value: opts.rfc822MessageId });
  return {
    id: opts.id,
    threadId: opts.threadId,
    internalDate: String(opts.internalDate ?? Date.parse('2026-04-01T12:00:00Z')),
    payload: {
      mimeType: 'text/plain',
      headers,
      body: opts.body ? { data: Buffer.from(opts.body).toString('base64url') } : undefined,
    },
  };
}

describe('parseGmailMessage', () => {
  it('extracts from/to/subject/body/sent_at from a plain message', () => {
    const m = gmailMessage({
      id: 'g1',
      threadId: 't1',
      from: 'Sender <sender@example.com>',
      to: 'Operator <dustin@heronlabsinc.com>',
      subject: 'Order #5012',
      body: 'Can you confirm shipping?',
      internalDate: Date.parse('2026-03-15T09:30:00Z'),
    });
    const parsed = parseGmailMessage(m);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.message_id).toBe('g1');
    expect(parsed.thread_id).toBe('t1');
    expect(parsed.from_addr).toBe('sender@example.com');
    expect(parsed.to_addr).toBe('dustin@heronlabsinc.com');
    expect(parsed.subject).toBe('Order #5012');
    expect(parsed.body).toBe('Can you confirm shipping?');
    expect(parsed.sent_at).toBe('2026-03-15T09:30:00.000Z');
  });

  it('extracts text/plain from a multipart payload preferring plain over html', () => {
    const m: GmailMessage = {
      id: 'g2',
      threadId: 't2',
      internalDate: String(Date.parse('2026-03-16T09:30:00Z')),
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'From', value: 'a@x.com' },
          { name: 'To', value: OPERATOR },
        ],
        parts: [
          {
            mimeType: 'text/plain',
            body: { data: Buffer.from('plain body').toString('base64url') },
          },
          {
            mimeType: 'text/html',
            body: { data: Buffer.from('<p>html body</p>').toString('base64url') },
          },
        ],
      },
    };
    const parsed = parseGmailMessage(m);
    expect(parsed?.body).toBe('plain body');
  });

  it('falls back to text/html stripped of tags when text/plain is absent', () => {
    const m: GmailMessage = {
      id: 'g3',
      threadId: 't3',
      internalDate: String(Date.parse('2026-03-17T09:30:00Z')),
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'From', value: 'a@x.com' },
          { name: 'To', value: OPERATOR },
        ],
        parts: [
          {
            mimeType: 'text/html',
            body: { data: Buffer.from('<p>hello <b>world</b></p>').toString('base64url') },
          },
        ],
      },
    };
    const parsed = parseGmailMessage(m);
    expect(parsed?.body.replace(/\s+/g, ' ').trim()).toBe('hello world');
  });

  it('returns null when id or threadId is missing', () => {
    expect(parseGmailMessage({ id: '', threadId: 't' } as GmailMessage)).toBeNull();
    expect(parseGmailMessage({ id: 'g', threadId: '' } as GmailMessage)).toBeNull();
  });

  it('falls back to top-level header fields when payload.headers is absent', () => {
    // The MailBOX-FetchHistory n8n workflow flattens common headers to the
    // message top-level instead of preserving payload.headers[]. Verified
    // against the live workflow on 2026-05-02 — without this fallback the
    // backfill silently extracts 0 pairs from valid threads.
    const m = {
      id: 'g-flat',
      threadId: 't-flat',
      internalDate: String(Date.parse('2026-05-01T16:00:00Z')),
      payload: {
        mimeType: 'text/plain',
        body: { data: Buffer.from('hi').toString('base64url') },
      },
      From: 'dustin@heronlabsinc.com',
      To: 'Eric Gang <eric@staqs.io>',
      Subject: 'Re: Reorder',
      'Message-Id': '<flat-msgid@mail.gmail.com>',
      'In-Reply-To': '<orig@mail.gmail.com>',
    } as unknown as GmailMessage;
    const parsed = parseGmailMessage(m);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.from_addr).toBe('dustin@heronlabsinc.com');
    expect(parsed.to_addr).toBe('eric@staqs.io');
    expect(parsed.subject).toBe('Re: Reorder');
    expect(parsed.rfc822_message_id).toBe('<flat-msgid@mail.gmail.com>');
    expect(parsed.in_reply_to).toBe('<orig@mail.gmail.com>');
  });
});

describe('extractReplyPairs', () => {
  function thread(id: string, messages: GmailMessage[]): FetchHistoryThread {
    return { id, messages };
  }

  it('emits one pair per outbound, paired with the most recent prior inbound', () => {
    const t = thread('T1', [
      gmailMessage({
        id: 'm1',
        threadId: 'T1',
        from: 'sender@example.com',
        to: OPERATOR,
        subject: 'Order',
        body: 'Need confirmation.',
        internalDate: 1,
      }),
      gmailMessage({
        id: 'm2',
        threadId: 'T1',
        from: OPERATOR,
        to: 'sender@example.com',
        subject: 'Re: Order',
        body: 'Confirmed shipping today.',
        internalDate: 2,
      }),
    ]);
    const pairs = extractReplyPairs(t, OPERATOR);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.inbound.message_id).toBe('m1');
    expect(pairs[0]?.reply.message_id).toBe('m2');
  });

  it('emits one pair per outbound in multi-reply threads', () => {
    const t = thread('T2', [
      gmailMessage({
        id: 'm1',
        threadId: 'T2',
        from: 'a@x.com',
        to: OPERATOR,
        body: 'q1',
        internalDate: 1,
      }),
      gmailMessage({
        id: 'm2',
        threadId: 'T2',
        from: OPERATOR,
        to: 'a@x.com',
        body: 'a1',
        internalDate: 2,
      }),
      gmailMessage({
        id: 'm3',
        threadId: 'T2',
        from: 'a@x.com',
        to: OPERATOR,
        body: 'q2',
        internalDate: 3,
      }),
      gmailMessage({
        id: 'm4',
        threadId: 'T2',
        from: OPERATOR,
        to: 'a@x.com',
        body: 'a2',
        internalDate: 4,
      }),
    ]);
    const pairs = extractReplyPairs(t, OPERATOR);
    expect(pairs.map((p) => [p.inbound.message_id, p.reply.message_id])).toEqual([
      ['m1', 'm2'],
      ['m3', 'm4'],
    ]);
  });

  it('skips an outbound with no prior inbound (operator-initiated thread)', () => {
    const t = thread('T3', [
      gmailMessage({
        id: 'm1',
        threadId: 'T3',
        from: OPERATOR,
        to: 'a@x.com',
        body: 'cold',
        internalDate: 1,
      }),
      gmailMessage({
        id: 'm2',
        threadId: 'T3',
        from: 'a@x.com',
        to: OPERATOR,
        body: 'reply',
        internalDate: 2,
      }),
    ]);
    const pairs = extractReplyPairs(t, OPERATOR);
    expect(pairs).toHaveLength(0);
  });

  it('handles back-to-back outbound messages by pairing both against the same prior inbound', () => {
    const t = thread('T4', [
      gmailMessage({
        id: 'm1',
        threadId: 'T4',
        from: 'a@x.com',
        to: OPERATOR,
        body: 'q',
        internalDate: 1,
      }),
      gmailMessage({
        id: 'm2',
        threadId: 'T4',
        from: OPERATOR,
        to: 'a@x.com',
        body: 'a1',
        internalDate: 2,
      }),
      gmailMessage({
        id: 'm3',
        threadId: 'T4',
        from: OPERATOR,
        to: 'a@x.com',
        body: 'a2 follow-up',
        internalDate: 3,
      }),
    ]);
    const pairs = extractReplyPairs(t, OPERATOR);
    expect(pairs.map((p) => p.reply.message_id)).toEqual(['m2', 'm3']);
    expect(pairs.every((p) => p.inbound.message_id === 'm1')).toBe(true);
  });

  it('matches operator email case-insensitively', () => {
    const t = thread('T5', [
      gmailMessage({
        id: 'm1',
        threadId: 'T5',
        from: 'a@x.com',
        to: OPERATOR,
        body: 'q',
        internalDate: 1,
      }),
      gmailMessage({
        id: 'm2',
        threadId: 'T5',
        from: 'Dustin@HeronLabsInc.com',
        to: 'a@x.com',
        body: 'a',
        internalDate: 2,
      }),
    ]);
    const pairs = extractReplyPairs(t, OPERATOR);
    expect(pairs).toHaveLength(1);
  });

  it('returns empty for a thread with no messages', () => {
    const t = thread('T6', []);
    expect(extractReplyPairs(t, OPERATOR)).toEqual([]);
  });
});

describe('callFetchHistory', () => {
  it('returns parsed body on 200', async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          days_lookback: 30,
          after_date: '2026/04/01',
          thread_count: 0,
          threads: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const r = await callFetchHistory(
      'http://test/webhook',
      { days_lookback: 30 },
      fetchFn,
      async () => undefined,
    );
    expect(r.thread_count).toBe(0);
  });

  it('retries on 429 and succeeds on the next attempt', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls === 1) return new Response('rate limit', { status: 429 });
      return new Response(
        JSON.stringify({
          ok: true,
          days_lookback: 30,
          after_date: '2026/04/01',
          thread_count: 0,
          threads: [],
        }),
        { status: 200 },
      );
    };
    const r = await callFetchHistory(
      'http://test/webhook',
      { days_lookback: 30 },
      fetchFn,
      async () => undefined,
    );
    expect(calls).toBe(2);
    expect(r.thread_count).toBe(0);
  });

  it('retries up to 3 times on 5xx then throws', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return new Response('boom', { status: 500 });
    };
    await expect(
      callFetchHistory(
        'http://test/webhook',
        { days_lookback: 30 },
        fetchFn,
        async () => undefined,
      ),
    ).rejects.toThrow();
    // Initial attempt + 3 retries = 4 calls.
    expect(calls).toBe(4);
  });
});
