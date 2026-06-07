// dashboard/lib/tuning/style.ts
//
// MBOX-162 P5a (Tuning · Style tab) — the operator-facing "voice knobs" shape
// and its mapping to/from persona.statistical_markers.
//
// The Style tab is a friendly editor over a SUBSET of statistical_markers. It
// never owns the whole markers object — the route merges these keys in and
// preserves everything else (extraction-derived markers, category_exemplars).
//
// Marker keys this tab owns (and how they map):
//   formality        (0–100 slider) ↔ marker `formality_score` (0..1)
//   sentence_length                 ↔ marker `sentence_length_pref`
//   greeting                        ↔ marker `greeting_pattern`
//   closing                         ↔ marker `signoff`        (the sign-off line)
//   emoji_policy                    ↔ marker `emoji_policy`
//   jargon_allowlist                ↔ marker `jargon_allowlist`
//
// Note: this tab does NOT write the literal `tone` marker. The drafting resolver
// derives tone from `formality_score` UNLESS a literal `tone` override exists
// (set via the legacy persona JSON editor), which takes precedence. The Style
// tab surfaces this so the operator isn't surprised.

export type SentenceLength = '' | 'short' | 'medium' | 'long';
export type EmojiPolicy = '' | 'never' | 'sparingly' | 'match_customer';

export const SENTENCE_LENGTHS = ['short', 'medium', 'long'] as const;
export const EMOJI_POLICIES = ['never', 'sparingly', 'match_customer'] as const;

export interface StyleProfile {
  /** 0–100 slider. Maps to the [0,1] `formality_score` marker. */
  formality: number;
  /** '' = auto (model picks). */
  sentence_length: SentenceLength;
  /** Greeting template, e.g. "Hi {firstName},". '' = auto. */
  greeting: string;
  /** Sign-off / closing line. Maps to the existing `signoff` marker. '' = default. */
  closing: string;
  /** '' = auto. */
  emoji_policy: EmojiPolicy;
  /** Domain terms the drafter may use verbatim. */
  jargon_allowlist: string[];
}

export const DEFAULT_STYLE_PROFILE: StyleProfile = {
  formality: 50,
  sentence_length: '',
  greeting: '',
  closing: '',
  emoji_policy: '',
  jargon_allowlist: [],
};

function clampFormality(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_STYLE_PROFILE.formality;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | '' {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : '';
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// Read the Style subset out of a full statistical_markers object. Used by the
// /settings/tuning server loader to seed the form. Tolerant of missing/garbage
// markers — everything degrades to the neutral default.
export function markersToStyle(markers: Record<string, unknown>): StyleProfile {
  const score = typeof markers.formality_score === 'number' ? markers.formality_score : null;
  return {
    formality: score == null ? DEFAULT_STYLE_PROFILE.formality : clampFormality(score * 100),
    sentence_length: asEnum(markers.sentence_length_pref, SENTENCE_LENGTHS),
    greeting: asString(markers.greeting_pattern),
    closing: asString(markers.signoff),
    emoji_policy: asEnum(markers.emoji_policy, EMOJI_POLICIES),
    jargon_allowlist: asStringArray(markers.jargon_allowlist),
  };
}

// Convert a (validated) StyleProfile into the marker keys it owns, ready to be
// merged into the existing statistical_markers. Empty string / empty array are
// written as-is — they're valid "clear this knob" values that the drafting
// resolver reads as "unset" (no prompt line).
export function styleToMarkers(style: StyleProfile): Record<string, unknown> {
  return {
    formality_score: clampFormality(style.formality) / 100,
    sentence_length_pref: style.sentence_length,
    greeting_pattern: style.greeting.trim(),
    signoff: style.closing.trim(),
    emoji_policy: style.emoji_policy,
    jargon_allowlist: asStringArray(style.jargon_allowlist),
  };
}

// True when a literal `tone` override is present — formality won't drive tone in
// that case (resolver precedence). The UI uses this to warn the operator.
export function hasLiteralToneOverride(markers: Record<string, unknown>): boolean {
  return typeof markers.tone === 'string' && markers.tone.trim().length > 0;
}
