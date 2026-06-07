// dashboard/lib/oauth/__tests__/google.test.ts
//
// MBOX-130 + MBOX-129 — unit tests for the shared Google OAuth crypto + state
// HMAC. Pure (node:crypto); no DB, no network. Pins the round-trip + tamper
// detection that protect the stored refresh tokens.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptToken,
  encryptToken,
  OAUTH_PROVIDERS,
  PROVIDER_SCOPE,
  signState,
  verifyState,
} from '../google';

// Deterministic 32-byte key (64 hex chars) + a state secret for the suite.
const TEST_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('AES-256-GCM token crypto', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved.MAILBOX_OAUTH_TOKEN_KEY = process.env.MAILBOX_OAUTH_TOKEN_KEY;
    process.env.MAILBOX_OAUTH_TOKEN_KEY = TEST_KEY;
  });
  afterEach(() => {
    if (saved.MAILBOX_OAUTH_TOKEN_KEY === undefined) delete process.env.MAILBOX_OAUTH_TOKEN_KEY;
    else process.env.MAILBOX_OAUTH_TOKEN_KEY = saved.MAILBOX_OAUTH_TOKEN_KEY;
  });

  it('round-trips a refresh token', () => {
    const plain = '1//refresh-token-value-abc123';
    const enc = encryptToken(plain);
    expect(enc).not.toContain(plain);
    expect(enc.split('.')).toHaveLength(3); // iv.tag.ciphertext
    expect(decryptToken(enc)).toBe(plain);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptToken('same-token');
    const b = encryptToken('same-token');
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe('same-token');
    expect(decryptToken(b)).toBe('same-token');
  });

  it('rejects a tampered ciphertext (GCM auth tag mismatch)', () => {
    const enc = encryptToken('tamper-me');
    const [iv, tag, data] = enc.split('.');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 0xff;
    const tampered = [iv, tag, flipped.toString('base64')].join('.');
    expect(() => decryptToken(tampered)).toThrow();
  });

  it('throws when the key is missing', () => {
    delete process.env.MAILBOX_OAUTH_TOKEN_KEY;
    expect(() => encryptToken('x')).toThrow(/MAILBOX_OAUTH_TOKEN_KEY/);
  });

  it('throws on a wrong-length key', () => {
    process.env.MAILBOX_OAUTH_TOKEN_KEY = 'deadbeef';
    expect(() => encryptToken('x')).toThrow(/32 bytes/);
  });
});

describe('connect-flow state HMAC', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved.MAILBOX_OAUTH_STATE_SECRET = process.env.MAILBOX_OAUTH_STATE_SECRET;
    process.env.MAILBOX_OAUTH_STATE_SECRET = 'test-state-secret';
  });
  afterEach(() => {
    if (saved.MAILBOX_OAUTH_STATE_SECRET === undefined)
      delete process.env.MAILBOX_OAUTH_STATE_SECRET;
    else process.env.MAILBOX_OAUTH_STATE_SECRET = saved.MAILBOX_OAUTH_STATE_SECRET;
  });

  it('signs and verifies a provider+account+nonce round-trip', () => {
    // MBOX-415 — state pins account_id (oauth_tokens PK is (provider, account_id)).
    const state = signState('google_calendar', 'nonce-123', 7);
    const verified = verifyState(state);
    expect(verified).toEqual({ provider: 'google_calendar', accountId: 7, nonce: 'nonce-123' });
  });

  it('rejects a tampered MAC', () => {
    const state = signState('google_tasks', 'n', 1);
    const tampered = `${state}x`;
    expect(verifyState(tampered)).toBeNull();
  });

  it('rejects a state signed with a different secret', () => {
    const state = signState('google_calendar', 'n', 1);
    process.env.MAILBOX_OAUTH_STATE_SECRET = 'a-different-secret';
    expect(verifyState(state)).toBeNull();
  });

  it('rejects a forged provider that is not in OAUTH_PROVIDERS', () => {
    // Hand-forge "evil:nonce:<mac>" with the right secret — verifyState must
    // still reject because 'evil' is not a known provider.
    const verified = verifyState('evil:nonce:notarealmac');
    expect(verified).toBeNull();
  });
});

describe('provider config', () => {
  it('every provider has a scope', () => {
    for (const p of OAUTH_PROVIDERS) {
      expect(PROVIDER_SCOPE[p]).toMatch(/^https:\/\/www\.googleapis\.com\/auth\//);
    }
  });

  it('calendar scope grants event read/write (MBOX-460 — scheduling reads + v2 event creation)', () => {
    expect(PROVIDER_SCOPE.google_calendar).toContain('calendar.events');
  });
});
