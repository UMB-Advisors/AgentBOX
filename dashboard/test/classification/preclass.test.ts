import { afterEach, describe, expect, it } from 'vitest';
import { normalizeClassifierOutput } from '@/lib/classification/normalize';
import { precheckNoReply } from '@/lib/classification/preclass';

// STAQPRO-260 — noreply-pattern preclass tests. Companion to the
// operator-domain preclass (DR-50) — same module, opposite direction.

describe('precheckNoReply', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('positive matches', () => {
    it.each([
      'noreply@github.com',
      'no-reply@stripe.com',
      'donotreply@example.com',
      'do-not-reply@bank.com',
      'notifications@github.com',
      'notification@vendor.com',
      'mailer-daemon@whatever.example',
      'postmaster@example.org',
      'bounces@listmonk.io',
      // V1 broadening — token-adjacent-to-@ with delimiter on the other
      // side. Without these, `drive-shares-dm-noreply@google.com` slipped
      // past the gate and a draft was generated for a Google Drive share.
      'drive-shares-dm-noreply@google.com',
      'alerts+notifications@example.com',
      'system.noreply@example.com',
      'foo_no-reply@example.com',
      // john.notifications@gmail.com — was a negative case in the
      // anchored regex era; intentionally flipped by V1. Real human
      // operators using a `notifications`-suffixed alias as a primary
      // address are vanishingly rare; OPERATOR_ALLOWLIST is the escape.
      'john.notifications@gmail.com',
    ])('drops %s as spam_marketing', (addr) => {
      const hit = precheckNoReply({ from: addr });
      expect(hit).toEqual({
        category: 'spam_marketing',
        confidence: 1,
        source: 'noreply-pattern',
      });
    });

    it('matches noreply subdomain in the domain part', () => {
      // GitHub uses notifications@github.com (local-part rule), but other
      // services route via subdomain like alerts@noreply.example.com
      expect(precheckNoReply({ from: 'alerts@noreply.example.com' })?.source).toBe(
        'noreply-pattern',
      );
      expect(precheckNoReply({ from: 'msg@notifications.zendesk.com' })?.source).toBe(
        'noreply-pattern',
      );
    });

    it('handles "Display Name <addr>" headers', () => {
      const hit = precheckNoReply({ from: 'GitHub <notifications@github.com>' });
      expect(hit?.source).toBe('noreply-pattern');
    });

    it('is case-insensitive', () => {
      expect(precheckNoReply({ from: 'NoReply@GITHUB.COM' })?.source).toBe('noreply-pattern');
    });
  });

  describe('negative matches', () => {
    it.each([
      'noreplyguy@example.com', // no delimiter between "noreply" and "guy"
      'replies@foo.com', // not "noreply"
      'eric@staqs.io',
      'sales@heronlabsinc.com',
      'nicky@heronlabsinc.com',
      'norman@gmail.com', // contains "no" as a substring, not a token
      // Trailing `@` anchor in LOCAL_PART_TOKEN_RE protects domain matches.
      'eric@notifications-co.com',
      // Plus-addressed newsletters with no noreply token in the local-part
      // are deferred to V2 (header-based List-Unsubscribe detection).
      'notanotherceo+podcast@substack.com',
      // Plain product-team aliases without a noreply token. Atlassian's
      // `jira@*.atlassian.net` is the canonical example — operators can
      // opt-in via `NOREPLY_PATTERNS` env if they want to drop these.
      'jira@company.atlassian.net',
    ])('does not match %s', (addr) => {
      expect(precheckNoReply({ from: addr })).toBeNull();
    });

    it('returns null on empty/missing from', () => {
      expect(precheckNoReply({})).toBeNull();
      expect(precheckNoReply({ from: '' })).toBeNull();
    });
  });

  describe('kill switch', () => {
    it('returns null when NOREPLY_PRECLASS_DISABLE=1, regardless of pattern match', () => {
      process.env.NOREPLY_PRECLASS_DISABLE = '1';
      expect(precheckNoReply({ from: 'noreply@github.com' })).toBeNull();
    });

    it('does not honor disable=0 (only "1" disables)', () => {
      process.env.NOREPLY_PRECLASS_DISABLE = '0';
      expect(precheckNoReply({ from: 'noreply@github.com' })?.source).toBe('noreply-pattern');
    });
  });

  // OPERATOR_ALLOWLIST escape hatch is implementation-tested via code review:
  // precheckNoReply checks OPERATOR_ALLOWLIST early-return before pattern
  // matching. Module-level env constants (OPERATOR_ALLOWLIST is captured at
  // import time) make a runtime test require resetModules acrobatics that
  // aren't worth the complexity for this rarely-hit edge case.
});

describe('normalizeClassifierOutput — noreply preclass wiring', () => {
  it('overrides LLM verdict with spam_marketing when sender is noreply', () => {
    // LLM said "internal", which would normally route to local. Noreply
    // preclass should clobber that.
    const result = normalizeClassifierOutput(
      JSON.stringify({ category: 'internal', confidence: 0.92 }),
      { from: 'notifications@github.com' },
    );
    expect(result.category).toBe('spam_marketing');
    expect(result.preclass_applied).toBe(true);
    expect(result.preclass_source).toBe('noreply-pattern');
    // Confidence is replaced with the deterministic 1.0
    expect(result.confidence).toBe(1);
    // Original LLM output preserved for forensics
    expect(result.raw_output).toContain('internal');
  });

  it('runs noreply BEFORE operator-domain (notifications@operator.com still drops)', () => {
    // Edge case: a noreply-shaped address on the operator domain. Without
    // ordering, operator-domain would route it to `internal`. With our
    // change, noreply wins.
    const result = normalizeClassifierOutput(
      JSON.stringify({ category: 'unknown', confidence: 0.4 }),
      { from: 'notifications@heronlabsinc.com' },
    );
    expect(result.category).toBe('spam_marketing');
    expect(result.preclass_source).toBe('noreply-pattern');
  });

  it('does not interfere with normal classifications', () => {
    const result = normalizeClassifierOutput(
      JSON.stringify({ category: 'inquiry', confidence: 0.85 }),
      { from: 'eric@staqs.io' },
    );
    expect(result.category).toBe('inquiry');
    expect(result.preclass_applied).toBe(false);
    expect(result.preclass_source).toBeNull();
  });
});
