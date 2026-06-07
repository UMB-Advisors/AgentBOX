// MBOX-357 (P1 T6) — pure response classifiers for the raw-socket IMAP/SMTP
// test-connection probe. The socket plumbing is exercised on-box (DR-56
// residual); these classifiers are where the protocol-parsing risk lives, so
// they get deterministic coverage.

import { describe, expect, it } from 'vitest';
import { imapLoginVerdict, isSmtpFinalLine, smtpCode, smtpVerdict } from '../test-connection';

describe('imapLoginVerdict', () => {
  it('accepts the tagged OK completion', () => {
    expect(imapLoginVerdict('a1 OK LOGIN completed', 'a1')).toEqual({
      ok: true,
      detail: 'IMAP login OK',
    });
  });

  it('rejects NO / BAD with the server detail', () => {
    expect(imapLoginVerdict('a1 NO [AUTHENTICATIONFAILED] bad creds', 'a1')?.ok).toBe(false);
    expect(imapLoginVerdict('a1 BAD syntax', 'a1')?.ok).toBe(false);
  });

  it('returns null for untagged (`*`) lines and other tags (keep reading)', () => {
    expect(imapLoginVerdict('* CAPABILITY IMAP4rev1', 'a1')).toBeNull();
    expect(imapLoginVerdict('a2 OK something else', 'a1')).toBeNull();
  });
});

describe('smtpCode / isSmtpFinalLine', () => {
  it('parses the leading 3-digit code', () => {
    expect(smtpCode('250-PIPELINING')).toBe(250);
    expect(smtpCode('235 2.7.0 Accepted')).toBe(235);
    expect(smtpCode('not a code')).toBeNull();
  });

  it('distinguishes final (space) from continuation (hyphen) lines', () => {
    expect(isSmtpFinalLine('250 OK')).toBe(true);
    expect(isSmtpFinalLine('250-PIPELINING')).toBe(false);
    expect(isSmtpFinalLine('* untagged')).toBe(false);
  });
});

describe('smtpVerdict', () => {
  it('treats 2xx as ok', () => {
    expect(smtpVerdict(220, 'greeting').ok).toBe(true);
    expect(smtpVerdict(250, 'EHLO').ok).toBe(true);
  });

  it('flags 535 as bad credentials and other codes as failures', () => {
    expect(smtpVerdict(535, 'AUTH').detail).toMatch(/bad username\/password/i);
    expect(smtpVerdict(421, 'greeting').ok).toBe(false);
    expect(smtpVerdict(null, 'EHLO').ok).toBe(false);
  });
});
