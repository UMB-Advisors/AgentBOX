// web/src/lib/tuningStyle.ts
//
// MBOX-475 — drafting "voice knobs" shape + its mapping to/from the mailbox
// persona ``statistical_markers``. Ported verbatim (data + pure functions) from
// the retiring mailbox dashboard ``lib/tuning/style.ts`` so the Tuning · Style
// tab in the Hermes dash serializes the SAME marker keys the mailbox drafting
// pipeline reads. No Hermes-side persistence: the page seeds from
// ``GET /dashboard/api/persona`` and writes via ``PUT /dashboard/api/tuning/style``
// (both proxied to the on-box mailbox dashboard → Postgres).
//
// The Style tab is a friendly editor over a SUBSET of statistical_markers. It
// never owns the whole markers object — the mailbox route merges these keys in
// and preserves everything else (extraction-derived markers, exemplars). This
// module is the client-side seed mapper only; the merge stays server-side.
//
// Marker keys this tab owns (and how they map):
//   formality        (0–100 slider) ↔ marker `formality_score` (0..1)
//   sentence_length                 ↔ marker `sentence_length_pref`
//   greeting                        ↔ marker `greeting_pattern`
//   closing                         ↔ marker `signoff`        (the sign-off line)
//   emoji_policy                    ↔ marker `emoji_policy`
//   jargon_allowlist                ↔ marker `jargon_allowlist`
//
// Note: this tab does NOT write the literal `tone` marker (that lives in the
// persona surface — MBOX-476). The drafting resolver derives tone from
// `formality_score` UNLESS a literal `tone` override exists, which takes
// precedence. The Style tab surfaces that so the operator isn't surprised.

export type SentenceLength = "" | "short" | "medium" | "long";
export type EmojiPolicy = "" | "never" | "sparingly" | "match_customer";

export const SENTENCE_LENGTHS = ["short", "medium", "long"] as const;
export const EMOJI_POLICIES = ["never", "sparingly", "match_customer"] as const;

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
  sentence_length: "",
  greeting: "",
  closing: "",
  emoji_policy: "",
  jargon_allowlist: [],
};

function clampFormality(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_STYLE_PROFILE.formality;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | "" {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : "";
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Read the Style subset out of a full statistical_markers object. Used to seed
 * the form from ``GET /dashboard/api/persona``. Tolerant of missing/garbage
 * markers — everything degrades to the neutral default.
 */
export function markersToStyle(
  markers: Record<string, unknown> | null | undefined,
): StyleProfile {
  const m = markers ?? {};
  const score = typeof m.formality_score === "number" ? m.formality_score : null;
  return {
    formality:
      score == null
        ? DEFAULT_STYLE_PROFILE.formality
        : clampFormality(score * 100),
    sentence_length: asEnum(m.sentence_length_pref, SENTENCE_LENGTHS),
    greeting: asString(m.greeting_pattern),
    closing: asString(m.signoff),
    emoji_policy: asEnum(m.emoji_policy, EMOJI_POLICIES),
    jargon_allowlist: asStringArray(m.jargon_allowlist),
  };
}

/**
 * True when a literal `tone` override is present — formality won't drive tone in
 * that case (resolver precedence). The UI uses this to warn the operator.
 */
export function hasLiteralToneOverride(
  markers: Record<string, unknown> | null | undefined,
): boolean {
  const tone = markers?.tone;
  return typeof tone === "string" && tone.trim().length > 0;
}

export function formalityLabel(n: number): string {
  if (n < 20) return "Very casual";
  if (n < 40) return "Casual";
  if (n < 60) return "Balanced";
  if (n < 80) return "Formal";
  return "Very formal";
}

// ── Guidelines (prompt_rules) ──────────────────────────────────────────────

export const PROMPT_RULE_SCOPES = [
  "always",
  "prefer",
  "avoid",
  "never",
] as const;
export type PromptRuleScope = (typeof PROMPT_RULE_SCOPES)[number];
