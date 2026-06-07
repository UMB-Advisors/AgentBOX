import { type NextRequest, NextResponse } from 'next/server';
import { buildPrompt, MODEL_VERSION } from '@/lib/classification/prompt';
import { getPersonaContext } from '@/lib/drafting/persona';
import { parseJson } from '@/lib/middleware/validate';
import { classificationPromptBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

// D-29 — single source of truth for classification prompt. Consumed by n8n
// classify sub-workflow at run time so the prompt cannot drift between live
// pipeline and scoring script.
//
// POST (not GET, per D-29 letter) because email bodies are too large for a
// query string. Behavior is still pure & read-only.
//
// CPG-scrub Phase 1 (2026-05-08): the system framing is now persona-derived
// instead of hardcoded "small CPG brand operator". Pulls business_description
// from the operator's persona override (set during onboarding) and templates
// it into the classifier prompt. Falls back to generic "small business
// operator" framing when business_description is empty.
export async function POST(req: NextRequest) {
  const b = await parseJson(req, classificationPromptBodySchema);
  if (!b.ok) return b.response;

  try {
    const persona = await getPersonaContext();
    const framing = personaToClassifyFraming(persona);
    const prompt = buildPrompt(b.data, framing);
    return NextResponse.json({ prompt, model: MODEL_VERSION });
  } catch (error) {
    console.error('POST /api/internal/classification-prompt failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

// Industry-aware framing for the classifier system prompt. Cleaner than
// inlining inside the route — reusable from the scoring script too if/when
// scripts/heron-labs-score.mjs grows persona awareness.
function personaToClassifyFraming(persona: {
  operator_brand: string;
  business_description: string;
}): string {
  const desc = persona.business_description?.trim();
  const brand = persona.operator_brand?.trim();
  if (desc && brand && brand !== "the operator's business") {
    return `${brand} — ${desc}`;
  }
  if (desc) {
    return desc;
  }
  return ''; // buildPrompt falls back to "a small business operator"
}
