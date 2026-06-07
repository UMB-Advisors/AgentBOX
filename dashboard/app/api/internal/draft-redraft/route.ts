import {
  readLlamaCppBaseUrl,
  readLlamaCppModel,
  readOllamaBaseUrl,
  readRuntimeKind,
  SSE_HEADERS,
  sseStreamFromEvents,
  streamLocalChat,
} from '@umb-advisors/llm';
import { type NextRequest, NextResponse } from 'next/server';
import type { Category } from '@/lib/classification/prompt';
import { getKysely } from '@/lib/db';
import { getPersonaContext } from '@/lib/drafting/persona';
import { assembleRedraftMessages } from '@/lib/drafting/redraft';
import { stripQuotedAndSignature } from '@/lib/drafting/strip-quoting';
import { parseJson } from '@/lib/middleware/validate';
import { getOperatorSettings } from '@/lib/queries-operator-settings';
import { draftRedraftBodySchema } from '@/lib/schemas/internal';

// POST /api/internal/draft-redraft — P3 (MBOX-162) operator redraft-with-prompt.
// Streams a LOCAL-model rewrite of the operator's current draft body, refined by
// a free-text instruction, as Server-Sent Events. Mirrors the chat-stream
// sibling (llm/api/chat/stream): LOCAL-ONLY (DR-53/SM-73) — no field or branch
// can redirect to a cloud provider. The operator Applies the result through the
// existing inline-edit path; this route never mutates the draft.
//
// Feature-flagged: stays dark until MAILBOX_REDRAFT_ENABLED=1. Off → 403 so the
// loop can be validated on M1 before exposure (the queue page also hides the
// button when the flag is off).

const REDRAFT_ENABLED = process.env.MAILBOX_REDRAFT_ENABLED === '1';

// SSE requires the response to stream; opt out of static optimization.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  if (!REDRAFT_ENABLED) {
    return NextResponse.json(
      { error: 'redraft is disabled (set MAILBOX_REDRAFT_ENABLED=1)' },
      { status: 403 },
    );
  }

  const parsed = await parseJson(req, draftRedraftBodySchema);
  if (!parsed.ok) return parsed.response;
  const { draft_id, current_body, instruction } = parsed.data;

  // Load inbound context server-side (never trust the client for the inbound)
  // — same columns the draft-prompt route reads.
  const db = getKysely();
  const row = await db
    .selectFrom('drafts')
    .select([
      'id',
      'from_addr',
      'to_addr',
      'subject',
      'body_text',
      'classification_category',
      'classification_confidence',
      'status',
      // MBOX-352 (MBOX-162 V2) — resolve persona for the draft's owning account.
      'account_id',
    ])
    .where('id', '=', draft_id)
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    return NextResponse.json({ error: `draft ${draft_id} not found` }, { status: 404 });
  }
  // Only actionable drafts can be redrafted (mirrors the edit route's gate).
  if (row.status !== 'pending' && row.status !== 'edited') {
    return NextResponse.json(
      { error: `draft ${draft_id} is not in a redraftable state (${row.status})` },
      { status: 409 },
    );
  }
  const category = row.classification_category as Category | null;
  if (!category) {
    return NextResponse.json(
      { error: `draft ${draft_id} has no classification_category` },
      { status: 422 },
    );
  }

  // MBOX-162 P4 follow-up — operator_settings (singleton) for the booking_link;
  // read in parallel with persona so the redraft carries the same scheduling-link
  // instruction the initial draft did.
  const [persona, operatorSettings] = await Promise.all([
    getPersonaContext(row.account_id),
    getOperatorSettings(),
  ]);
  const strippedInbound = stripQuotedAndSignature(row.body_text ?? '');

  const messages = assembleRedraftMessages({
    base: {
      from_addr: row.from_addr ?? '',
      to_addr: row.to_addr ?? '',
      subject: row.subject ?? '',
      body_text: strippedInbound.body,
      category,
      confidence: row.classification_confidence ?? 0,
      persona,
      booking_link: operatorSettings.booking_link,
    },
    current_body,
    instruction,
  });

  // LOCAL-ONLY: resolve baseUrl + model strictly from the on-device runtime
  // config (DR-53/SM-73), exactly like the chat-stream route.
  const runtime = readRuntimeKind();
  const baseUrl = runtime === 'llama-cpp' ? readLlamaCppBaseUrl() : readOllamaBaseUrl();
  const model = runtime === 'llama-cpp' ? readLlamaCppModel() : 'qwen3:4b-ctx4k';

  const events = streamLocalChat(
    runtime,
    { messages, options: { temperature: 0.7 } },
    { baseUrl, model, signal: req.signal },
  );

  const stream = sseStreamFromEvents(events, runtime);
  return new NextResponse(stream, { status: 200, headers: SSE_HEADERS });
}
