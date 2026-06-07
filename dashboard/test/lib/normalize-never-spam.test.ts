import { describe, expect, it } from 'vitest';
import { normalizeClassifierOutput } from '@/lib/classification/normalize';
import { isOperatorAddress } from '@/lib/classification/preclass';

// MBOX-370 follow-up — the `neverSpam` PreclassContext flag. When set (sender is
// on the never-spam allowlist), the heuristic SUPPRESSIONS (noreply + self-loop)
// are skipped so the real category stands; a genuine model spam_marketing verdict
// is surfaced to `unknown` instead of dropped. This is the fix for jt@-style
// operator-domain replies to external prospects being self-loop-dropped as spam.

const spam = JSON.stringify({ category: 'spam_marketing', confidence: 0.9 });
const inquiry = JSON.stringify({ category: 'inquiry', confidence: 0.8 });

describe('normalizeClassifierOutput — neverSpam flag', () => {
  it('skips the noreply suppression for an allowlisted sender', () => {
    const ctx = { from: 'noreply@vendor.com', to: 'op@heronlabsinc.com' };
    // Baseline: noreply pattern drops to spam_marketing.
    expect(normalizeClassifierOutput(inquiry, ctx).category).toBe('spam_marketing');
    // neverSpam: noreply suppression skipped → the model's real category stands.
    const r = normalizeClassifierOutput(inquiry, { ...ctx, neverSpam: true });
    expect(r.category).toBe('inquiry');
    expect(r.route).not.toBe('drop');
  });

  it('surfaces a genuine model spam verdict to unknown (not dropped) for an allowlisted sender', () => {
    const ctx = { from: 'vendor@external.com', to: 'op@heronlabsinc.com', neverSpam: true };
    const r = normalizeClassifierOutput(spam, ctx);
    expect(r.category).toBe('unknown');
    expect(r.preclass_source).toBe('sender-never-spam');
    expect(r.route).toBe('cloud'); // unknown → cloud → gets a draft for review
    expect(r.suppression_reason).toBeNull();
  });

  it('leaves a non-spam verdict unchanged under neverSpam', () => {
    const r = normalizeClassifierOutput(inquiry, {
      from: 'vendor@external.com',
      to: 'op@heronlabsinc.com',
      neverSpam: true,
    });
    expect(r.category).toBe('inquiry');
    expect(r.preclass_source).toBeNull();
  });

  // The jt@-style case: an operator-domain sender replying to an EXTERNAL
  // recipient is self-loop-dropped as spam normally; with neverSpam the self-loop
  // suppression is skipped and operator-domain resolves it to `internal`.
  // Guarded on isOperatorAddress so it stays correct regardless of the
  // OPERATOR_DOMAINS env in the test runner.
  it('resolves an operator-domain self-loop to internal under neverSpam', () => {
    const from = 'jt@heronlabsinc.com';
    const to = 'kate@cactuspacific.com'; // external
    if (!isOperatorAddress(from)) return; // env doesn't treat this as operator — skip
    const baseline = normalizeClassifierOutput(spam, { from, to });
    expect(baseline.category).toBe('spam_marketing');
    expect(baseline.suppression_reason).toBe('self_loop');

    const r = normalizeClassifierOutput(spam, { from, to, neverSpam: true });
    expect(r.category).toBe('internal');
    expect(r.suppression_reason).toBeNull();
    expect(r.route).not.toBe('drop');
  });
});
