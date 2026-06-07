// dashboard/lib/mail/providers/__tests__/gmail.test.ts
//
// MBOX-356 (P0) — GmailProvider unit coverage. This is part of the S-MP-1 gate:
// the dashboard-side Gmail logic must behave identically post-extraction.

import { describe, expect, it } from 'vitest';
import { GmailProvider, NotImplementedInP0, providerFor, providerForKind } from '..';

const gmail = new GmailProvider();

describe('GmailProvider.normalize', () => {
  it('maps a full Gmail-shaped inbound payload to a CanonicalMessage', () => {
    const msg = gmail.normalize({
      message_id: 'abc123',
      thread_id: 't-1',
      from_addr: 'a@x.com',
      to_addr: 'b@y.com',
      subject: 'Re: hi',
      body: 'hello',
      in_reply_to: '<m1@x>',
      references: '<m0@x>',
      received_at: '2026-05-29T00:00:00.000Z',
    });
    expect(msg).toEqual({
      provider_message_id: 'abc123',
      thread_id: 't-1',
      from_addr: 'a@x.com',
      to_addr: 'b@y.com',
      subject: 'Re: hi',
      body: 'hello',
      in_reply_to: '<m1@x>',
      references: '<m0@x>',
      received_at: '2026-05-29T00:00:00.000Z',
      direction: 'inbound',
    });
  });

  it('falls back to empty/null on missing fields and snippet→body', () => {
    const msg = gmail.normalize({ message_id: 'x', snippet: 'preview' });
    expect(msg.body).toBe('preview');
    expect(msg.thread_id).toBeNull();
    expect(msg.in_reply_to).toBeNull();
    expect(msg.from_addr).toBe('');
    expect(msg.direction).toBe('inbound');
  });

  it('respects an explicit outbound direction', () => {
    expect(gmail.normalize({ message_id: 'x', direction: 'outbound' }).direction).toBe('outbound');
  });
});

describe('GmailProvider.normalizeThreadId', () => {
  it('passes the native Gmail thread id through', () => {
    expect(gmail.normalizeThreadId(gmail.normalize({ message_id: 'x', thread_id: 't-9' }))).toBe(
      't-9',
    );
  });
});

describe('GmailProvider.parseRateLimit', () => {
  it('extracts a future Retry-after hint from an error string', () => {
    const { until } = gmail.parseRateLimit(
      '429 Too Many Requests. Retry after 2099-01-01T00:00:00.000Z',
    );
    expect(until?.toISOString()).toBe('2099-01-01T00:00:00.000Z');
  });

  it('returns null for a hint already in the past (no-op cooldown)', () => {
    expect(gmail.parseRateLimit('Retry after 2000-01-01T00:00:00.000Z').until).toBeNull();
  });

  it('returns null when there is no hint', () => {
    expect(gmail.parseRateLimit('some unrelated error').until).toBeNull();
    expect(gmail.parseRateLimit(new Error('boom')).until).toBeNull();
    expect(gmail.parseRateLimit(undefined).until).toBeNull();
  });
});

describe('GmailProvider capabilities + I/O boundary', () => {
  it('declares native threading, poll-only, gmail quote strategy', () => {
    expect(gmail.capabilities).toEqual({
      nativeThreading: true,
      push: false,
      quoteStrategy: 'gmail',
    });
  });

  it('still throws NotImplementedInP0 for the live poll/send I/O (n8n owns it)', () => {
    const acct = { id: 1, provider: 'gmail' as const, provider_config: {} };
    expect(() => gmail.listNew(acct, null)).toThrow(NotImplementedInP0);
    expect(() =>
      gmail.send(acct, {
        thread_id: null,
        in_reply_to: null,
        to_addr: 'a@b.c',
        subject: 's',
        body: 'b',
      }),
    ).toThrow(NotImplementedInP0);
  });

  // MBOX-399 (V6 P3) — backfillSent is the first dashboard-owned Gmail I/O
  // (DR-56). It's an async generator now (no longer NotImplementedInP0): the
  // access token is injected via provider_config.access_token by the
  // orchestrator. A missing token is a wiring bug that surfaces on iteration,
  // not a synchronous throw at call time.
  it('backfillSent rejects on iteration when no access_token is injected', async () => {
    const acct = { id: 1, provider: 'gmail' as const, provider_config: {} };
    await expect(async () => {
      for await (const _ of gmail.backfillSent(acct, { lookbackHours: 24 })) {
        // unreachable — the missing-token guard throws before the first yield
      }
    }).rejects.toThrow(/no access_token/);
  });
});

describe('providerFor factory', () => {
  it('returns a GmailProvider for gmail', () => {
    expect(providerFor({ provider: 'gmail' }).kind).toBe('gmail');
    expect(providerForKind('gmail')).toBeInstanceOf(GmailProvider);
  });

  it('resolves every MAIL_PROVIDERS kind to a provider instance', () => {
    // imap implemented in P1 (MBOX-357), microsoft in P2 (MBOX-358) — each
    // arm has its own provider tests; here we just assert the factory no longer
    // throws for any declared kind (the exhaustiveness guard stays for new ones).
    expect(providerForKind('imap').kind).toBe('imap');
    expect(providerForKind('microsoft').kind).toBe('microsoft');
  });
});
