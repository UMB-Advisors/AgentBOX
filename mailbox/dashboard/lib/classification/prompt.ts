// Canonical Qwen3 classification prompt.
// Single source of truth (D-29). Consumed by:
//   - n8n classify sub-workflow via GET /api/internal/classification-prompt
//   - scripts/heron-labs-score.mjs (imports this module directly)
// Keep this file diff-friendly — n8n cannot inline-edit the prompt.

export const CATEGORIES = [
  'inquiry',
  'reorder',
  'scheduling',
  'follow_up',
  'internal',
  'spam_marketing',
  'escalate',
  'unknown',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const MODEL_VERSION = 'qwen3:4b-ctx4k';

export const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  inquiry:
    'First-touch question from a prospect or customer (pricing, samples, product info, partnership intro).',
  reorder: 'Existing customer placing or asking about a repeat order, restock, PO, or invoice.',
  scheduling: 'Meeting, call, visit, sample drop, or calendar logistics.',
  follow_up: 'Continuation of a prior thread the recipient was already engaged in.',
  internal: 'From a team member, contractor, or known internal stakeholder of the operator.',
  spam_marketing:
    'Cold solicitation, marketing newsletter, sales pitch, lead-gen blast, recruiter spam.',
  escalate:
    'Complaint, legal threat, regulatory notice, recall risk, or anything requiring human judgment.',
  unknown: 'Cannot be confidently placed in any other category.',
};

export interface ClassifierInput {
  from: string;
  subject: string;
  body: string;
}

// /no_think directive per D-05 — keeps classification under p95 5s (MAIL-06).
// Fallback to `unknown` on parse failure is enforced in normalize.ts (D-06).
//
// `businessFraming` is the operator-business descriptor — populated during
// onboarding via the persona resolver and forwarded by the route handler.
// Empty / unset → falls back to a generic "small business operator" framing
// (CPG-scrub Phase 1, 2026-05-08; replaces the prior hardcoded "small CPG
// brand operator" anchor that biased Qwen3 against non-CPG mail on M2).
export function buildPrompt(input: ClassifierInput, businessFraming?: string): string {
  const catLines = CATEGORIES.map((c) => `  - ${c}: ${CATEGORY_DESCRIPTIONS[c]}`).join('\n');

  const safeBody = (input.body ?? '').slice(0, 4000);

  const framing = (businessFraming ?? '').trim() || 'a small business operator';

  return `/no_think
You are an email classifier for ${framing}.
Classify the email into exactly one of these 8 categories:

${catLines}

Output a single JSON object and nothing else:
{"category": "<one of the 8>", "confidence": <number from 0 to 1>}

Rules:
- "category" must be one of: ${CATEGORIES.join(', ')}.
- "confidence" reflects how sure you are (0.0 = guessing, 1.0 = certain).
- If unsure, use "unknown" with low confidence rather than guessing.
- No prose, no markdown, no explanations — JSON only.

Email:
From: ${input.from ?? ''}
Subject: ${input.subject ?? ''}
Body:
${safeBody}
`;
}

// Routing rule per D-01 / D-02. Pure function; n8n IF node mirrors this logic
// (D-30). Exposed here so scripts/scoring/dashboard diagnostics can evaluate
// the same routing without re-implementing it.
//
// 2026-05-01 retune: 'inquiry' moved local — Eric's "do as much as we can
// with a local model" call. The 3-way eval (Qwen3 vs gpt-oss:120b vs Haiku)
// showed Qwen3's "vague defer" on inquiry is actually preferred over
// gpt-oss's hallucinated pricing template. The strengthened persona prompt
// (with explicit [confirm with operator] examples) closes the gap further.
// Confidence floor still kicks low-confidence drafts to cloud as the safety
// net.
export const LOCAL_CONFIDENCE_FLOOR = 0.75;
export const LOCAL_CATEGORIES: ReadonlyArray<Category> = [
  'reorder',
  'scheduling',
  'follow_up',
  'internal',
  'inquiry',
];
export const CLOUD_CATEGORIES: ReadonlyArray<Category> = ['escalate', 'unknown'];

export type Route = 'local' | 'cloud' | 'drop';

export function routeFor(category: Category, confidence: number): Route {
  if (category === 'spam_marketing') return 'drop';
  if (confidence < LOCAL_CONFIDENCE_FLOOR) return 'cloud';
  if (LOCAL_CATEGORIES.includes(category)) return 'local';
  return 'cloud';
}

// STAQPRO-331 #3 — explanation for why a draft took its route. Operator-facing
// in the DraftDetail RoutingBadge; lets the reviewer distinguish "model was
// confident, took the normal path" from "fell back to cloud as a safety net."
// Pure derivation from existing columns (no new schema). Returns null when
// classification metadata is missing or the source is a legacy
// `local_qwen3` / `cloud_haiku` value the live drafter no longer writes.
export type RoutingReason =
  | 'local_category'
  | 'cloud_category'
  | 'cloud_low_confidence'
  | 'unknown';

export function routingReasonFor(
  source: 'local' | 'cloud' | 'local_qwen3' | 'cloud_haiku',
  category: Category | null,
  confidence: number | null,
): RoutingReason {
  if (source !== 'local' && source !== 'cloud') return 'unknown';
  if (category == null) return 'unknown';
  if (source === 'local') {
    return LOCAL_CATEGORIES.includes(category) ? 'local_category' : 'unknown';
  }
  // source === 'cloud'
  if (confidence != null && confidence < LOCAL_CONFIDENCE_FLOOR) {
    return 'cloud_low_confidence';
  }
  if (CLOUD_CATEGORIES.includes(category)) return 'cloud_category';
  return 'unknown';
}
