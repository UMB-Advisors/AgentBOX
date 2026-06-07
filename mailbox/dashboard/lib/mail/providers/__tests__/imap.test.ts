// dashboard/lib/mail/providers/__tests__/imap.test.ts
//
// MBOX-357 (P1) — ImapSmtpProvider pure logic (T1) + threading synthesis (T2).
// The threading cases are the S-MP-2 gate in miniature: prove that messages in
// the same conversation resolve to one stable thread_id from header chains.

import { describe, expect, it } from 'vitest';
import { ImapSmtpProvider, NotImplementedYet, providerFor, providerForKind } from '..';
import { parseSentRfc822 } from '../imap';

const imap = new ImapSmtpProvider();

describe('ImapSmtpProvider.normalize', () => {
  it('maps an IMAP payload, tolerating n8n/imapflow key variants', () => {
    const msg = imap.normalize({
      messageId: '<abc@host>',
      from: 'a@x.com',
      to: 'b@y.com',
      subject: 'Re: hi',
      text: 'hello',
      inReplyTo: '<m1@x>',
      references: '<m0@x> <m1@x>',
      date: '2026-05-29T00:00:00.000Z',
    });
    expect(msg.provider_message_id).toBe('abc@host'); // angle brackets stripped
    expect(msg.from_addr).toBe('a@x.com');
    expect(msg.to_addr).toBe('b@y.com');
    expect(msg.body).toBe('hello'); // text → body
    expect(msg.in_reply_to).toBe('m1@x');
    expect(msg.received_at).toBe('2026-05-29T00:00:00.000Z'); // date → received_at
    expect(msg.direction).toBe('inbound');
  });

  it('also accepts the canonical snake_case keys', () => {
    const msg = imap.normalize({
      message_id: 'bare-id',
      from_addr: 'a@x.com',
      to_addr: 'b@y.com',
      body: 'hi',
      received_at: '2026-05-29T00:00:00.000Z',
    });
    expect(msg.provider_message_id).toBe('bare-id');
    expect(msg.in_reply_to).toBeNull();
    expect(msg.references).toBeNull();
  });
});

describe('ImapSmtpProvider.normalizeThreadId (S-MP-2 synthesis)', () => {
  it('uses the References ROOT (oldest id), not the most recent', () => {
    const m = imap.normalize({ message_id: '<r3@h>', references: '<root@h> <r2@h>' });
    // thread keyed on root@h, deterministic + provenance-prefixed
    expect(m.thread_id).toMatch(/^imap-[0-9a-f]{32}$/);
    expect(m.thread_id).toBe(
      imap.normalize({ message_id: '<other@h>', references: '<root@h>' }).thread_id,
    );
  });

  it('a root message and a reply that references it share ONE thread_id', () => {
    const root = imap.normalize({ message_id: '<root@h>' }); // no refs / no in-reply-to
    const reply = imap.normalize({
      message_id: '<r2@h>',
      references: '<root@h> <r1@h>',
      in_reply_to: '<r1@h>',
    });
    expect(root.thread_id).toBe(reply.thread_id);
  });

  it('falls back to In-Reply-To when there is no References header', () => {
    const m = imap.normalize({ message_id: '<r2@h>', in_reply_to: '<parent@h>' });
    expect(m.thread_id).toBe(imap.normalize({ message_id: '<parent@h>' }).thread_id);
  });

  it('treats a message with no chain headers as its own thread root', () => {
    const m = imap.normalize({ message_id: '<solo@h>' });
    expect(m.thread_id).not.toBeNull();
  });

  it('returns null thread_id when there is no usable identifier at all', () => {
    expect(imap.normalize({ subject: 'orphan' }).thread_id).toBeNull();
  });
});

describe('ImapSmtpProvider.parseRateLimit', () => {
  it('detects SMTP 4xx / textual throttle signals → future cooldown', () => {
    for (const e of [
      '421 4.7.0 Try again later',
      '450 mailbox busy',
      'Too many concurrent connections',
      new Error('Account temporarily rate limited'),
    ]) {
      const { until } = imap.parseRateLimit(e);
      expect(until).not.toBeNull();
      expect(until!.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('returns null for a non-throttle error', () => {
    expect(imap.parseRateLimit('550 mailbox not found').until).toBeNull();
    expect(imap.parseRateLimit('connection reset').until).toBeNull();
  });
});

describe('ImapSmtpProvider capabilities + boundaries', () => {
  it('declares synthesized threading, poll-only, generic quote strategy', () => {
    expect(imap.capabilities).toEqual({
      nativeThreading: false,
      push: false,
      quoteStrategy: 'generic',
    });
  });

  it('listNew/send still throw NotImplementedYet (P1 T5, pending DR-56)', () => {
    const acct = { id: 1, provider: 'imap' as const, provider_config: {} };
    expect(() => imap.listNew(acct, null)).toThrow(NotImplementedYet);
    expect(() =>
      imap.send(acct, {
        thread_id: null,
        in_reply_to: null,
        to_addr: 'a@b.c',
        subject: 's',
        body: 'b',
      }),
    ).toThrow(NotImplementedYet);
    // backfillSent is now implemented (MBOX-373 P2) — it's an async generator,
    // so it no longer throws synchronously. Its behavior is covered by the
    // parseSentRfc822 fixture tests below + the DB-backed orchestrator suite.
  });
});

describe('providerFor factory — imap arm (P1)', () => {
  it('returns an ImapSmtpProvider for imap', () => {
    expect(providerForKind('imap')).toBeInstanceOf(ImapSmtpProvider);
    expect(providerFor({ provider: 'imap' }).kind).toBe('imap');
  });
});

// MBOX-373 (MBOX-162 V6 P2) — parseSentRfc822: pure RFC822 → CanonicalMessage.
// No IMAP connection; runs unconditionally off fixture .eml strings.
describe('parseSentRfc822 (MBOX-373 P2 Sent-backfill MIME parse)', () => {
  const FULL_EML = [
    'Message-ID: <sent-123@mail.example.com>',
    'In-Reply-To: <inbound-1@customer.com>',
    'References: <root-0@customer.com> <inbound-1@customer.com>',
    'Date: Fri, 29 May 2026 12:00:00 +0000',
    'From: Operator <OPERATOR@Example.com>',
    'To: Customer <Customer@Buyer.COM>',
    'Subject: Re: your order',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Thanks for the order — shipping today.',
    '',
  ].join('\r\n');

  it('maps headers → CanonicalMessage, lowercases addresses, strips <> off Message-ID', async () => {
    const msg = await parseSentRfc822(FULL_EML);
    expect(msg.provider_message_id).toBe('sent-123@mail.example.com');
    expect(msg.from_addr).toBe('operator@example.com');
    expect(msg.to_addr).toBe('customer@buyer.com');
    expect(msg.subject).toBe('Re: your order');
    expect(msg.body).toContain('shipping today');
    expect(msg.in_reply_to).toBe('inbound-1@customer.com');
    // References array is joined with a single space, oldest→newest preserved.
    expect(msg.references).toBe('<root-0@customer.com> <inbound-1@customer.com>');
    expect(msg.received_at).toBe('2026-05-29T12:00:00.000Z');
    expect(msg.direction).toBe('outbound');
  });

  it('synthesizes an imap- thread_id from the References root', async () => {
    const msg = await parseSentRfc822(FULL_EML);
    expect(msg.thread_id).toMatch(/^imap-[0-9a-f]{32}$/);
    // Same root → same thread_id as the inbound normalize path (shared synthesis).
    const sibling = new ImapSmtpProvider().normalize({
      message_id: '<root-0@customer.com>',
    });
    expect(msg.thread_id).toBe(sibling.thread_id);
  });

  it('missing Message-ID → empty provider_message_id, thread_id null (no chain)', async () => {
    const noId = [
      'Date: Fri, 29 May 2026 12:00:00 +0000',
      'From: op@example.com',
      'To: c@buyer.com',
      'Subject: hi',
      '',
      'body',
      '',
    ].join('\r\n');
    const msg = await parseSentRfc822(noId);
    expect(msg.provider_message_id).toBe('');
    // No References, no In-Reply-To, and no own id → no usable thread root.
    expect(msg.thread_id).toBeNull();
  });
});
