import { describe, expect, it } from 'vitest';
import { resolvePersonaContext } from '@/lib/drafting/persona';

// STAQPRO-195: pure-eval tests for the persona resolver. The DB-backed path
// (getPersonaContext) is exercised through the existing draft-prompt route
// tests; the resolver IS the interesting logic here.

describe('resolvePersonaContext', () => {
  it('returns industry-neutral fallback for empty markers (CPG-scrub Phase 1)', () => {
    const r = resolvePersonaContext({});
    expect(r.tone).toMatch(/concise, direct, warm/);
    expect(r.signoff).toBe('Best,\n[operator name]');
    expect(r.operator_first_name).toBe('the operator');
    expect(r.operator_brand).toBe("the operator's business");
    expect(r.business_description).toBe('');
  });

  it('formality_score >= 0.7 derives formal tone', () => {
    const r = resolvePersonaContext({ formality_score: 0.85 });
    expect(r.tone).toMatch(/formal, deliberate/);
  });

  it('formality_score in [0.4, 0.7) derives the warm-direct tone', () => {
    const r = resolvePersonaContext({ formality_score: 0.55 });
    expect(r.tone).toMatch(/concise, direct, warm/);
  });

  it('formality_score < 0.4 derives casual tone', () => {
    const r = resolvePersonaContext({ formality_score: 0.2 });
    expect(r.tone).toMatch(/casual, conversational/);
  });

  it('explicit operator-set tone overrides extraction', () => {
    const r = resolvePersonaContext({
      formality_score: 0.85, // would derive formal
      tone: 'crisp, no greeting, lead with the ask',
    });
    expect(r.tone).toBe('crisp, no greeting, lead with the ask');
  });

  it('signoff falls back through operator-set → sign_off_top → hardcoded', () => {
    expect(resolvePersonaContext({ signoff: '-- Dustin' }).signoff).toBe('-- Dustin');

    expect(resolvePersonaContext({ sign_off_top: ['Best,', 'Thanks,'] }).signoff).toBe('Best,');

    expect(resolvePersonaContext({ sign_off_top: [] }).signoff).toBe('Best,\n[operator name]');
    expect(resolvePersonaContext({ sign_off_top: ['', '   '] }).signoff).toBe(
      'Best,\n[operator name]',
    );
  });

  it('operator_first_name + operator_brand + business_description override fallback', () => {
    const r = resolvePersonaContext({
      operator_first_name: 'Sarah',
      operator_brand: 'EnerGemz',
      business_description: 'small-batch functional gummy CPG',
    });
    expect(r.operator_first_name).toBe('Sarah');
    expect(r.operator_brand).toBe('EnerGemz');
    expect(r.business_description).toBe('small-batch functional gummy CPG');
  });

  it('business_description independent of brand — Staqs-style tech-dev override', () => {
    const r = resolvePersonaContext({
      operator_first_name: 'Eric',
      operator_brand: 'Staqs',
      business_description: 'B2B tech / dev tools company',
      tone: 'casual, conversational, plain-spoken',
      signoff: 'Cheers, Eric',
    });
    expect(r.operator_brand).toBe('Staqs');
    expect(r.business_description).toBe('B2B tech / dev tools company');
    expect(r.tone).toBe('casual, conversational, plain-spoken');
    expect(r.signoff).toBe('Cheers, Eric');
  });

  it('non-string / non-finite values fall through cleanly', () => {
    const r = resolvePersonaContext({
      tone: 42 as unknown as string,
      signoff: null as unknown as string,
      formality_score: 'NaN' as unknown as number,
    });
    expect(r.tone).toMatch(/concise, direct, warm/); // FALLBACK kicks in
    expect(r.signoff).toBe('Best,\n[operator name]');
  });
});
