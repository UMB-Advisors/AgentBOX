// STAQPRO-195: replace persona-stub with reads from mailbox.persona.
//
// Same getPersonaContext() signature as the 2026-04-30 stub so the drafting
// pipeline (lib/drafting/prompt.ts + app/api/internal/draft-prompt/route.ts)
// keeps working unchanged. New behavior:
//   1. Load the persona row via getPersona() (kysely-typed)
//   2. Resolve each PersonaContext field with this fallback chain:
//      operator-override → extraction-derived → hardcoded fallback
//   3. Hardcoded fallback values match the original stub so the drafting
//      output is byte-identical until a real persona row is populated.

import { getPersona } from '@/lib/queries-persona';

export interface PersonaContext {
  tone: string;
  signoff: string;
  operator_first_name: string;
  operator_brand: string;
  /**
   * What the operator's business actually does — captured during onboarding
   * (e.g., "small-batch CPG operator", "B2B tech / dev tools company",
   * "veterinary clinic", "freelance illustrator"). Templated into both
   * classification and drafting prompts so the LLM gets industry-grounded
   * framing instead of a hardcoded vertical.
   *
   * Empty string means onboarding hasn't populated it yet; prompt builders
   * fall back to a generic "small business operator" framing.
   */
  business_description: string;

  // --- MBOX-162 P5a (Tuning · Style tab) ---
  // Operator-tunable voice knobs, set via the /settings/tuning Style tab and
  // stored as plain keys in persona.statistical_markers. Each is "unset" when
  // empty ('' or []) and contributes NO system-prompt line in that case, so a
  // fresh appliance — or one tuned only via the legacy persona JSON editor —
  // produces a byte-identical prompt to pre-P5a. Consumed by buildSystemPrompt's
  // voiceStyleLines (lib/drafting/prompt.ts), mirroring the bookingLinkSystemBlock
  // append-when-set discipline.
  //
  // Optional on the type: resolvePersonaContext ALWAYS populates them (so the
  // real drafting path is fully specified), but they stay `?` so the many
  // hand-built PersonaContext fixtures predating P5a — and any other caller that
  // doesn't care about voice knobs — remain valid without churn. Consumers treat
  // absent === unset.

  /** Preferred sentence length: '' (auto) | 'short' | 'medium' | 'long'. */
  sentence_length_pref?: '' | 'short' | 'medium' | 'long';
  /** Greeting template, e.g. "Hi {firstName}," — '' lets the model pick. */
  greeting_pattern?: string;
  /** Emoji policy: '' (auto) | 'never' | 'sparingly' | 'match_customer'. */
  emoji_policy?: '' | 'never' | 'sparingly' | 'match_customer';
  /** Domain terms the drafter may use verbatim. Empty = no allowlist line. */
  jargon_allowlist?: string[];
}

// Whitelisted enum values for the two constrained Style markers. Anything not
// in the set resolves to '' (unset) so a malformed marker can never inject a
// junk prompt line.
const SENTENCE_LENGTHS = ['short', 'medium', 'long'] as const;
const EMOJI_POLICIES = ['never', 'sparingly', 'match_customer'] as const;

// Industry-neutral hardcoded fallback (Phase 1 of the CPG-scrub, 2026-05-08).
// Pre-2026-05-08 the FALLBACK was Heron Labs / small-batch CPG specific —
// fine for customer #1, wrong for any non-CPG appliance (M2 = Staqs.io tech
// dev). New boxes ship with neutral defaults; the operator sets overrides
// during onboarding via the persona settings UI (STAQPRO-149) or via direct
// SQL during install. Live-gate flip should be blocked until at least
// `business_description` is populated, but that gate is owned by 02-08.
const FALLBACK: PersonaContext = {
  tone: 'concise, direct, warm — short paragraphs, no corporate hedging',
  signoff: 'Best,\n[operator name]',
  operator_first_name: 'the operator',
  operator_brand: "the operator's business",
  business_description: '',
  // Style knobs default to "unset" — they add no prompt line until tuned.
  sentence_length_pref: '',
  greeting_pattern: '',
  emoji_policy: '',
  jargon_allowlist: [],
};

// MBOX-352 (MBOX-162 V2) — persona is now resolved per account. `accountId`
// is optional and falls back to the seeded default account inside getPersona,
// so single-account callers (classification prompt, eval harness) that pass
// nothing behave exactly as before. The draft-prompt route passes the in-flight
// draft's account so a multi-mailbox appliance drafts in the right voice.
export async function getPersonaContext(accountId?: number): Promise<PersonaContext> {
  const row = await getPersona(accountId);
  const markers = (row?.statistical_markers ?? {}) as Record<string, unknown>;
  return resolvePersonaContext(markers);
}

// Pure resolver, exported for testing without a DB roundtrip.
export function resolvePersonaContext(markers: Record<string, unknown>): PersonaContext {
  return {
    tone: stringOr(
      markers.tone,
      deriveToneFromFormality(numberOr(markers.formality_score, null)) ?? FALLBACK.tone,
    ),
    signoff: stringOr(markers.signoff, firstNonEmpty(markers.sign_off_top) ?? FALLBACK.signoff),
    operator_first_name: stringOr(markers.operator_first_name, FALLBACK.operator_first_name),
    operator_brand: stringOr(markers.operator_brand, FALLBACK.operator_brand),
    business_description: stringOr(markers.business_description, FALLBACK.business_description),
    // Style knobs (MBOX-162 P5a) — no extraction-derived fallback; they're pure
    // operator overrides, so an absent/invalid marker resolves to '' / [] (unset).
    sentence_length_pref: enumOr(markers.sentence_length_pref, SENTENCE_LENGTHS),
    greeting_pattern: stringOr(markers.greeting_pattern, ''),
    emoji_policy: enumOr(markers.emoji_policy, EMOJI_POLICIES),
    jargon_allowlist: stringArrayOr(markers.jargon_allowlist),
  };
}

// formality_score lives in [0, 1] per lib/persona/extract.ts. Map to tone:
//   ≥ 0.7  → formal, deliberate
//   0.4..0.7 → concise, direct, warm  (matches the legacy Heron Labs default)
//   < 0.4  → casual, conversational
// Returns null when no formality_score exists yet (caller falls through to FALLBACK).
function deriveToneFromFormality(score: number | null): string | null {
  if (score == null) return null;
  if (score >= 0.7) return 'formal, deliberate — full sentences, professional register';
  if (score >= 0.4) return 'concise, direct, warm — short paragraphs, no corporate hedging';
  return 'casual, conversational — first-name basis, contractions OK';
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v : fallback;
}

function numberOr(v: unknown, fallback: number | null): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function firstNonEmpty(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  for (const item of v) {
    if (typeof item === 'string' && item.trim().length > 0) return item;
  }
  return null;
}

// Resolve a marker against a whitelist of allowed values. Returns the matched
// value, or '' (unset) for anything not in the set — so a malformed or stale
// marker degrades to "no prompt line" rather than injecting junk.
function enumOr<T extends string>(v: unknown, allowed: readonly T[]): T | '' {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : '';
}

// Resolve a marker to a clean string[] — trims, drops empties, ignores non-string
// items. Returns [] (unset) for anything that isn't an array.
function stringArrayOr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
