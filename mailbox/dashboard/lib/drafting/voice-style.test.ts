import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STYLE_PROFILE,
  hasLiteralToneOverride,
  markersToStyle,
  styleToMarkers,
} from '@/lib/tuning/style';
import { resolvePersonaContext } from './persona';
import { assemblePrompt, buildSystemPrompt, rulesSystemBlock, voiceStyleLines } from './prompt';

// MBOX-162 P5a (Tuning · Style tab) — pure-logic coverage for the voice knobs:
// resolver tolerance, prompt-line emission, the byte-identical-when-unset
// invariant, and the StyleProfile <-> markers mapping.

describe('resolvePersonaContext — Style markers', () => {
  it('resolves the new Style fields from markers', () => {
    const ctx = resolvePersonaContext({
      sentence_length_pref: 'short',
      greeting_pattern: 'Hey {firstName},',
      emoji_policy: 'sparingly',
      jargon_allowlist: ['MOQ', ' COA ', ''],
    });
    expect(ctx.sentence_length_pref).toBe('short');
    expect(ctx.greeting_pattern).toBe('Hey {firstName},');
    expect(ctx.emoji_policy).toBe('sparingly');
    // trimmed + empties dropped
    expect(ctx.jargon_allowlist).toEqual(['MOQ', 'COA']);
  });

  it('degrades unknown enum values to unset rather than injecting junk', () => {
    const ctx = resolvePersonaContext({
      sentence_length_pref: 'epic',
      emoji_policy: 42,
      jargon_allowlist: 'not-an-array',
    });
    expect(ctx.sentence_length_pref).toBe('');
    expect(ctx.emoji_policy).toBe('');
    expect(ctx.jargon_allowlist).toEqual([]);
  });

  it('defaults to all-unset for an empty persona', () => {
    const ctx = resolvePersonaContext({});
    expect(ctx.sentence_length_pref).toBe('');
    expect(ctx.greeting_pattern).toBe('');
    expect(ctx.emoji_policy).toBe('');
    expect(ctx.jargon_allowlist).toEqual([]);
  });
});

describe('voiceStyleLines', () => {
  it('emits nothing when every knob is unset', () => {
    expect(voiceStyleLines(resolvePersonaContext({}))).toEqual([]);
  });

  it('emits one line per set knob, skipping unset ones', () => {
    const lines = voiceStyleLines(
      resolvePersonaContext({
        sentence_length_pref: 'short',
        emoji_policy: 'never',
        jargon_allowlist: ['MOQ', 'COA'],
        // greeting deliberately unset
      }),
    );
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.includes('5–12 words'))).toBe(true);
    expect(lines).toContain('Do not use emoji.');
    expect(lines.some((l) => l.includes('MOQ, COA'))).toBe(true);
    expect(lines.some((l) => l.toLowerCase().includes('greeting'))).toBe(false);
  });

  it('templates the greeting line with the raw pattern', () => {
    const lines = voiceStyleLines(resolvePersonaContext({ greeting_pattern: 'Hi {firstName},' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Hi {firstName},');
  });
});

describe('buildSystemPrompt — byte-identical when unset', () => {
  it('produces the same prompt for an empty persona as for the legacy fields only', () => {
    const legacyOnly = resolvePersonaContext({
      operator_first_name: 'Dustin',
      operator_brand: 'Heron Labs',
      business_description: 'small-batch CPG operator',
    });
    const withUnsetStyle = resolvePersonaContext({
      operator_first_name: 'Dustin',
      operator_brand: 'Heron Labs',
      business_description: 'small-batch CPG operator',
      sentence_length_pref: '',
      greeting_pattern: '',
      emoji_policy: '',
      jargon_allowlist: [],
    });
    expect(buildSystemPrompt(withUnsetStyle)).toBe(buildSystemPrompt(legacyOnly));
  });

  it('injects the style directives only once a knob is set', () => {
    const base = resolvePersonaContext({ operator_first_name: 'Dustin' });
    const tuned = resolvePersonaContext({ operator_first_name: 'Dustin', emoji_policy: 'never' });
    expect(buildSystemPrompt(base)).not.toContain('Do not use emoji.');
    expect(buildSystemPrompt(tuned)).toContain('Do not use emoji.');
  });
});

describe('style <-> markers mapping', () => {
  it('round-trips a populated profile through markers', () => {
    const style = {
      formality: 80,
      sentence_length: 'medium' as const,
      greeting: 'Hi {firstName},',
      closing: 'Best,\nDustin',
      emoji_policy: 'sparingly' as const,
      jargon_allowlist: ['MOQ', 'COA'],
    };
    const markers = styleToMarkers(style);
    expect(markers.formality_score).toBeCloseTo(0.8, 5);
    expect(markers.signoff).toBe('Best,\nDustin');
    expect(markersToStyle(markers)).toEqual(style);
  });

  it('maps an empty markers object to the neutral default', () => {
    expect(markersToStyle({})).toEqual(DEFAULT_STYLE_PROFILE);
  });

  it('clamps out-of-range formality and converts to a [0,1] score', () => {
    expect(styleToMarkers({ ...DEFAULT_STYLE_PROFILE, formality: 250 }).formality_score).toBe(1);
    expect(styleToMarkers({ ...DEFAULT_STYLE_PROFILE, formality: -10 }).formality_score).toBe(0);
  });

  it('detects a literal tone override', () => {
    expect(hasLiteralToneOverride({ tone: 'formal, deliberate' })).toBe(true);
    expect(hasLiteralToneOverride({ tone: '   ' })).toBe(false);
    expect(hasLiteralToneOverride({})).toBe(false);
  });
});

// --- MBOX-162 P5b (Tuning · Guidelines tab) — rulesSystemBlock ---

describe('rulesSystemBlock', () => {
  it('returns empty for no rules', () => {
    expect(rulesSystemBlock()).toBe('');
    expect(rulesSystemBlock([])).toBe('');
  });

  it('returns empty when every rule is blank', () => {
    expect(rulesSystemBlock([{ scope: 'always', rule: '   ' }])).toBe('');
  });

  it('maps each scope to its imperative verb and bullets the rule', () => {
    const block = rulesSystemBlock([
      { scope: 'always', rule: 'lead with the answer' },
      { scope: 'prefer', rule: 'use the customer first name' },
      { scope: 'avoid', rule: 'corporate hedging' },
      { scope: 'never', rule: 'quote a price' },
    ]);
    expect(block).toContain('- Always: lead with the answer');
    expect(block).toContain('- Prefer to: use the customer first name');
    expect(block).toContain('- Avoid: corporate hedging');
    expect(block).toContain('- Never: quote a price');
    // Subordinated to the anti-hallucination rule.
    expect(block).toContain('confirm with operator');
  });

  it('keeps the system prompt byte-identical when no rules are present', () => {
    const persona = resolvePersonaContext({ operator_first_name: 'Dustin' });
    const base = assemblePrompt({
      from_addr: 'a@b.com',
      to_addr: 'ops@x.com',
      subject: 's',
      body_text: 'hi',
      category: 'inquiry',
      confidence: 0.9,
      persona,
    });
    const withEmptyRules = assemblePrompt({
      from_addr: 'a@b.com',
      to_addr: 'ops@x.com',
      subject: 's',
      body_text: 'hi',
      category: 'inquiry',
      confidence: 0.9,
      persona,
      prompt_rules: [],
    });
    expect(withEmptyRules.messages[0].content).toBe(base.messages[0].content);
  });

  it('injects the guidelines block into the assembled system message when set', () => {
    const persona = resolvePersonaContext({ operator_first_name: 'Dustin' });
    const assembled = assemblePrompt({
      from_addr: 'a@b.com',
      to_addr: 'ops@x.com',
      subject: 's',
      body_text: 'hi',
      category: 'inquiry',
      confidence: 0.9,
      persona,
      prompt_rules: [{ scope: 'never', rule: 'promise a ship date' }],
    });
    expect(assembled.messages[0].content).toContain('OPERATOR GUIDELINES');
    expect(assembled.messages[0].content).toContain('- Never: promise a ship date');
  });
});
