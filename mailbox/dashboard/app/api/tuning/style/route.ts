import { type NextRequest, NextResponse } from 'next/server';
import { parseJson, parseQuery } from '@/lib/middleware/validate';
import { mergePersonaMarkers } from '@/lib/queries-persona';
import { accountQuerySchema } from '@/lib/schemas/common';
import { styleProfileSchema } from '@/lib/schemas/tuning';
import { markersToStyle, styleToMarkers } from '@/lib/tuning/style';

// MBOX-162 P5a (Tuning · Style tab) — operator-facing voice knobs.
//
// PUT body = StyleProfile (formality, sentence_length, greeting, closing,
// emoji_policy, jargon_allowlist). The route maps it to the marker keys it owns
// and MERGES them into persona.statistical_markers (preserving extraction
// markers + category_exemplars). The drafting prompt consumes the resolved
// values via lib/drafting/persona.ts → buildSystemPrompt's voiceStyleLines.
//
// MBOX-374 — account-scoped via `?account=<id>`. Absent → the seeded default
// account (single-account behaviour unchanged). The Tuning page's account
// selector deep-links the chosen inbox, so the operator tunes per-mailbox voice.

export const dynamic = 'force-dynamic';

export async function PUT(request: NextRequest) {
  const q = parseQuery(request, accountQuerySchema);
  if (!q.ok) return q.response;
  const parsed = await parseJson(request, styleProfileSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const markers = styleToMarkers(parsed.data);
    const persona = await mergePersonaMarkers(markers, q.data.account);
    // Echo back the resolved Style profile so the client can re-sync from the
    // authoritative persisted markers (and pick up clamping/normalization).
    return NextResponse.json({ style: markersToStyle(persona.statistical_markers) });
  } catch (error) {
    console.error('PUT /api/tuning/style failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
