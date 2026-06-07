// dashboard/lib/drafting/__tests__/strip-quoting.test.ts
//
// STAQPRO-341 — unit tests for the quote/signature stripper. Pure function,
// no I/O; hermetic.

import { describe, expect, it } from 'vitest';
import { stripQuotedAndSignature } from '../strip-quoting';

describe('stripQuotedAndSignature', () => {
  it('returns empty for empty input', () => {
    const out = stripQuotedAndSignature('');
    expect(out.body).toBe('');
    expect(out.stripped_quoted).toBe(false);
    expect(out.stripped_signature).toBe(false);
    expect(out.original_length).toBe(0);
  });

  it('strips Gmail-style attribution line and everything after', () => {
    const input = [
      'Yes, that works for me. Friday at 10am.',
      '',
      'On Mon, May 13, 2026 at 10:23 AM Foo Bar <foo@bar.com> wrote:',
      '> Hey, can we move our meeting to Friday?',
      '> ',
      '> Thanks,',
      '> Foo',
    ].join('\n');
    const out = stripQuotedAndSignature(input);
    expect(out.body).toBe('Yes, that works for me. Friday at 10am.');
    expect(out.stripped_quoted).toBe(true);
  });

  it('strips Outlook-style "From: / Sent: / To:" header block', () => {
    const input = [
      'Confirmed — see you Friday.',
      '',
      'From: Foo Bar <foo@bar.com>',
      'Sent: Monday, May 13, 2026 10:23 AM',
      'To: Operator <operator@example.com>',
      'Subject: Re: Meeting',
      '',
      'Hi Operator,',
      '',
      'Can we reschedule?',
    ].join('\n');
    const out = stripQuotedAndSignature(input);
    expect(out.body).toBe('Confirmed — see you Friday.');
    expect(out.stripped_quoted).toBe(true);
  });

  it('strips "Begin forwarded message" block', () => {
    const input = [
      'FYI — see below.',
      '',
      'Begin forwarded message:',
      '',
      'From: someone@example.com',
      'Subject: Original message',
      '',
      'Hello there.',
    ].join('\n');
    const out = stripQuotedAndSignature(input);
    expect(out.body).toBe('FYI — see below.');
    expect(out.stripped_quoted).toBe(true);
  });

  it('strips RFC 3676 signature delimiter and everything after', () => {
    const input = [
      'Thanks for the order.',
      '',
      '-- ',
      'Eric Robinson',
      'Heron Labs',
      'eric@heronlabs.com',
    ].join('\n');
    const out = stripQuotedAndSignature(input);
    expect(out.body).toBe('Thanks for the order.');
    expect(out.stripped_signature).toBe(true);
  });

  it('strips trailing `> `-prefixed quote lines (top-post, no attribution)', () => {
    const input = [
      'Yes, that works.',
      '',
      '> Can we move the meeting to Friday?',
      '> Thanks,',
      '> Foo',
    ].join('\n');
    const out = stripQuotedAndSignature(input);
    expect(out.body).toBe('Yes, that works.');
    expect(out.stripped_quoted).toBe(true);
  });

  it('handles attribution + signature in same body (cuts at first, signature is inside cut block)', () => {
    const input = [
      'Sounds good.',
      '',
      'On May 13, 2026 at 10:23 AM Foo <foo@bar.com> wrote:',
      '> -- ',
      '> Foo Bar',
    ].join('\n');
    const out = stripQuotedAndSignature(input);
    expect(out.body).toBe('Sounds good.');
    expect(out.stripped_quoted).toBe(true);
    // Signature flag is false because the "-- " was inside the already-cut
    // attribution block, not in the surviving body.
    expect(out.stripped_signature).toBe(false);
  });

  it('handles fresh message + signature only (no quoting)', () => {
    const input = ['Hi — quick question about your March invoice.', '', '-- ', 'Alex'].join('\n');
    const out = stripQuotedAndSignature(input);
    expect(out.body).toBe('Hi — quick question about your March invoice.');
    expect(out.stripped_quoted).toBe(false);
    expect(out.stripped_signature).toBe(true);
  });

  it('leaves body untouched when no patterns match', () => {
    const input = 'Just a quick note — pricing looks good. Move forward when ready.';
    const out = stripQuotedAndSignature(input);
    expect(out.body).toBe(input);
    expect(out.stripped_quoted).toBe(false);
    expect(out.stripped_signature).toBe(false);
  });

  it('is idempotent — stripping already-stripped text is a no-op', () => {
    const raw = [
      'Confirmed.',
      '',
      'On May 13, 2026 at 10:23 AM Foo <foo@bar.com> wrote:',
      '> Question',
    ].join('\n');
    const first = stripQuotedAndSignature(raw);
    const second = stripQuotedAndSignature(first.body);
    expect(second.body).toBe(first.body);
    expect(second.stripped_quoted).toBe(false);
    expect(second.stripped_signature).toBe(false);
  });

  it('respects maxChars cap after stripping', () => {
    const input = 'A'.repeat(2000);
    const out = stripQuotedAndSignature(input, { maxChars: 500 });
    expect(out.body.length).toBe(500);
    expect(out.original_length).toBe(2000);
  });

  it('original_length reflects raw input, not post-strip', () => {
    const input = [
      'OK.',
      '',
      'On May 13, 2026 at 10:23 AM Foo <foo@bar.com> wrote:',
      '> blah blah blah blah blah blah',
    ].join('\n');
    const out = stripQuotedAndSignature(input);
    expect(out.original_length).toBe(input.length);
    expect(out.body.length).toBeLessThan(input.length);
  });

  it('handles multi-line Gmail attribution (wrapped)', () => {
    const input = [
      'Looks good.',
      '',
      'On Wednesday, May 13, 2026, Foo Bar',
      '<foo@bar.com> wrote:',
      '> Original message',
    ].join('\n');
    const out = stripQuotedAndSignature(input);
    expect(out.body).toBe('Looks good.');
    expect(out.stripped_quoted).toBe(true);
  });

  it('handles "-----Original Message-----" Outlook variant', () => {
    const input = [
      'Approved.',
      '',
      '-----Original Message-----',
      'From: Foo',
      'Subject: Approval needed',
      '',
      'Please approve.',
    ].join('\n');
    const out = stripQuotedAndSignature(input);
    expect(out.body).toBe('Approved.');
    expect(out.stripped_quoted).toBe(true);
  });
});
