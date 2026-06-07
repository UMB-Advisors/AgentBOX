import { describe, expect, it } from 'vitest';
import { scrubPII } from '@/lib/rag/scrub';

// STAQPRO-193 — exercise the regex set so a typo in the patterns doesn't
// silently leak PII into the embedded corpus. Edge cases first; happy path
// last.

describe('scrubPII — phone', () => {
  it('redacts a paren-style US phone', () => {
    const r = scrubPII('Call me at (415) 555-1234 tomorrow.');
    expect(r.text).toBe('Call me at [REDACTED:phone] tomorrow.');
    expect(r.counts.phone).toBe(1);
  });

  it('redacts a dash-style US phone', () => {
    const r = scrubPII('My number is 415-555-1234.');
    expect(r.text).toBe('My number is [REDACTED:phone].');
    expect(r.counts.phone).toBe(1);
  });

  it('redacts a dot-style US phone', () => {
    const r = scrubPII('415.555.1234');
    expect(r.text).toBe('[REDACTED:phone]');
    expect(r.counts.phone).toBe(1);
  });

  it('redacts +1 country-code phone', () => {
    const r = scrubPII('+1 415 555 1234 reachable any time');
    expect(r.text).toBe('[REDACTED:phone] reachable any time');
    expect(r.counts.phone).toBe(1);
  });

  it('redacts a 10-digit run', () => {
    const r = scrubPII('Call 4155551234 anytime.');
    expect(r.text).toBe('Call [REDACTED:phone] anytime.');
    expect(r.counts.phone).toBe(1);
  });

  it('redacts multiple phones in one body', () => {
    const r = scrubPII('Office (415) 555-1234, mobile 415-555-9999.');
    expect(r.text).toBe('Office [REDACTED:phone], mobile [REDACTED:phone].');
    expect(r.counts.phone).toBe(2);
  });

  it('does not redact a 4-digit order number', () => {
    const r = scrubPII('Order 5551 shipped.');
    expect(r.text).toBe('Order 5551 shipped.');
    expect(r.counts.phone).toBe(0);
  });

  it('does not redact an ISO date', () => {
    const r = scrubPII('Confirmed for 2026-05-02.');
    expect(r.text).toBe('Confirmed for 2026-05-02.');
    expect(r.counts.phone).toBe(0);
  });
});

describe('scrubPII — SSN', () => {
  it('redacts a NNN-NN-NNNN SSN', () => {
    const r = scrubPII('SSN: 123-45-6789 on file.');
    expect(r.text).toBe('SSN: [REDACTED:ssn] on file.');
    expect(r.counts.ssn).toBe(1);
  });

  it('does not redact a phone-shaped 3-3-4 number as SSN', () => {
    const r = scrubPII('Call 415-555-1234 today.');
    expect(r.counts.ssn).toBe(0);
    expect(r.counts.phone).toBe(1);
  });
});

describe('scrubPII — credit-card-ish', () => {
  it('redacts a 16-digit number with spaces', () => {
    const r = scrubPII('Card: 4111 1111 1111 1111 expires 09/29.');
    expect(r.text).toContain('[REDACTED:card]');
    expect(r.counts.card).toBe(1);
  });

  it('redacts a 16-digit number with dashes', () => {
    const r = scrubPII('Card 4111-1111-1111-1111 used.');
    expect(r.text).toContain('[REDACTED:card]');
    expect(r.counts.card).toBe(1);
  });

  it('redacts a 16-digit run with no separators', () => {
    const r = scrubPII('PAN: 4111111111111111');
    expect(r.text).toContain('[REDACTED:card]');
    expect(r.counts.card).toBe(1);
  });

  it('does not redact a 12-digit tracking number', () => {
    const r = scrubPII('Tracking 940011002030 in transit.');
    expect(r.counts.card).toBe(0);
  });
});

describe('scrubPII — kept (not scrubbed)', () => {
  it('keeps email addresses', () => {
    const r = scrubPII('Reach me at dustin@umbadvisors.com please.');
    expect(r.text).toBe('Reach me at dustin@umbadvisors.com please.');
    expect(r.counts).toEqual({ phone: 0, ssn: 0, card: 0 });
  });

  it('keeps URLs', () => {
    const r = scrubPII('Booking: https://cal.com/dustin/30min');
    expect(r.text).toBe('Booking: https://cal.com/dustin/30min');
  });

  it('keeps names (cannot algorithmically detect)', () => {
    const r = scrubPII('Dustin Powers will lead this one.');
    expect(r.text).toBe('Dustin Powers will lead this one.');
  });
});

describe('scrubPII — edge', () => {
  it('handles null + empty input', () => {
    expect(scrubPII(null).text).toBe('');
    expect(scrubPII(undefined).text).toBe('');
    expect(scrubPII('').text).toBe('');
  });

  it('handles a body with all three pattern types', () => {
    const r = scrubPII(
      'SSN 123-45-6789, card 4111 1111 1111 1111, phone (415) 555-1234. Email me dustin@example.com.',
    );
    expect(r.text).toBe(
      'SSN [REDACTED:ssn], card [REDACTED:card], phone [REDACTED:phone]. Email me dustin@example.com.',
    );
    expect(r.counts).toEqual({ phone: 1, ssn: 1, card: 1 });
  });
});
