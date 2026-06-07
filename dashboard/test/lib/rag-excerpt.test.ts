import { describe, expect, it } from 'vitest';
import { buildBodyExcerpt, buildEmbeddingInput, stripQuotedHistory } from '@/lib/rag/excerpt';

// STAQPRO-190 — body excerpt strategy. Goal: produce a short, signal-dense
// snippet from a raw email body so the resulting Qdrant payload doesn't
// blow the memory budget or the 4k Qwen3 context budget at retrieval time
// (DR-18).

describe('buildBodyExcerpt — STAQPRO-190', () => {
  it('returns empty string for empty / null input', () => {
    expect(buildBodyExcerpt('')).toBe('');
    expect(buildBodyExcerpt(null)).toBe('');
    expect(buildBodyExcerpt(undefined)).toBe('');
  });

  it('strips classic Gmail "On ... wrote:" reply blocks', () => {
    const body = `Quick yes from me.

On Mon, Apr 28, 2026 at 9:00 AM Sender <s@x.com> wrote:
> Original long thread...
> ...
> ...`;
    const e = buildBodyExcerpt(body);
    expect(e).toBe('Quick yes from me.');
    expect(e).not.toContain('Original');
  });

  it('strips lines starting with > (quoted reply text)', () => {
    const body = `Replying inline:

> Their question
My answer.`;
    const e = buildBodyExcerpt(body);
    expect(e).not.toContain('Their question');
    expect(e).toContain('My answer.');
  });

  it('drops common signature delimiter -- on its own line', () => {
    const body = `Hello there.

--
Regards,
Bob
Phone: 555-1234`;
    const e = buildBodyExcerpt(body);
    expect(e).toBe('Hello there.');
  });

  it('caps at the configured char limit', () => {
    const body = 'x'.repeat(2000);
    const e = buildBodyExcerpt(body, 100);
    expect(e.length).toBe(100);
  });

  it('collapses whitespace runs', () => {
    const body = 'Hello\n\n\n   world  \t  again';
    expect(buildBodyExcerpt(body)).toBe('Hello world again');
  });
});

describe('buildEmbeddingInput — STAQPRO-190', () => {
  it('prefixes a non-empty subject when both present', () => {
    expect(buildEmbeddingInput('Re: order', 'Confirming details.')).toBe(
      'Subject: Re: order\n\nConfirming details.',
    );
  });

  it('returns excerpt alone when subject empty', () => {
    expect(buildEmbeddingInput('', 'Body only.')).toBe('Body only.');
    expect(buildEmbeddingInput(null, 'Body only.')).toBe('Body only.');
  });

  it('returns subject alone when excerpt empty', () => {
    expect(buildEmbeddingInput('Just a subject', '')).toBe('Just a subject');
  });
});

describe('stripQuotedHistory — STAQPRO-221 (H4)', () => {
  it('returns empty string for empty / null input', () => {
    expect(stripQuotedHistory('')).toBe('');
    expect(stripQuotedHistory(null)).toBe('');
    expect(stripQuotedHistory(undefined)).toBe('');
  });

  it('strips Gmail "On <date>, <name> wrote:" block + > body', () => {
    const body = `Quick yes from me.

On Mon, Apr 28, 2026 at 9:00 AM Sender <s@x.com> wrote:
> Original long thread...
> ...still going`;
    const out = stripQuotedHistory(body);
    expect(out.trim()).toBe('Quick yes from me.');
    expect(out).not.toContain('Original');
  });

  it('strips Apple Mail "> On <date>, at <time>, <name> wrote:" block', () => {
    const body = `Sounds good.

> On Apr 28, 2026, at 9:00 AM, Sender <s@x.com> wrote:
> Long previous thread
> Continuing`;
    const out = stripQuotedHistory(body);
    expect(out.trim()).toBe('Sounds good.');
    expect(out).not.toContain('Continuing');
  });

  it('strips Outlook "-----Original Message-----" block', () => {
    const body = `Confirmed.

-----Original Message-----
From: Sender <s@x.com>
Sent: Monday, April 28, 2026 9:00 AM
To: Operator
Subject: Re: thing

Long thread body
Continuing`;
    const out = stripQuotedHistory(body);
    expect(out.trim()).toBe('Confirmed.');
    expect(out).not.toContain('Continuing');
  });

  it('strips standalone > lines (Gmail mid-message inline quotes)', () => {
    const body = `Replying inline:

> Their question
My answer.

> Another quoted line
Another reply.`;
    const out = stripQuotedHistory(body);
    expect(out).not.toContain('Their question');
    expect(out).not.toContain('Another quoted line');
    expect(out).toContain('My answer.');
    expect(out).toContain('Another reply.');
  });

  it('returns empty string on a body that is 100% quoted history', () => {
    // Phase-B outlier 19b853053d10bd18 — 99% quoted-history; tested at 100%
    // here so the gate downstream can collapse to inbound_too_thin.
    const body = `On Mon, Apr 28, 2026 at 9:00 AM Sender <s@x.com> wrote:
> The whole message
> is quote chain`;
    expect(stripQuotedHistory(body).trim()).toBe('');
  });

  it('preserves the substantive fragment when fresh-reply is tiny', () => {
    // Phase-B outlier 19b0ed17519285b1 — 2-char fresh reply over a quote
    // chain. Pre-H4, this embedded with the full chain dominating. Post-H4,
    // we return just 'ok' for the substantivity gate downstream to reject.
    const body = `ok

> On Apr 28, 2026, Sender <s@x.com> wrote:
> Long thread...`;
    expect(stripQuotedHistory(body).trim()).toBe('ok');
  });
});
