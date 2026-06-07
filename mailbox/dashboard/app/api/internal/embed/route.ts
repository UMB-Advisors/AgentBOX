import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { resolveIngestAccountId } from '@/lib/queries-accounts';
import { embedText } from '@/lib/rag/embed';
import { buildBodyExcerpt, buildEmbeddingInput } from '@/lib/rag/excerpt';
import { normalizeSender, upsertEmailPoint } from '@/lib/rag/qdrant';
import { embedRequestBodySchema } from '@/lib/schemas/rag';

export const dynamic = 'force-dynamic';

// POST /api/internal/embed — STAQPRO-190
//
// n8n calls this from MailBOX-Classify (after Insert Inbox) and from
// MailBOX-Send (after the Gmail Reply lands and status flips to sent). The
// route wraps the embed → upsert flow:
//   1. Build a body excerpt + embedding input from subject + body.
//   2. Embed via nomic-embed-text:v1.5 on the local Ollama (768d / cosine).
//   3. Upsert one Qdrant point in the `email_messages` collection, keyed by
//      a deterministic UUID derived from message_id (idempotent on re-runs).
//
// Failure handling: this endpoint always returns HTTP 200. If embed or
// upsert fail, the response carries `{ ok: false, reason: ... }` so n8n's
// "if errored" branch doesn't fire. RAG is augmentation, not gate — a
// momentarily-down Ollama or Qdrant must not stall the draft pipeline.
//
// Validation errors (bad body shape) DO return 400 — those are caller bugs,
// not transient infra failures, and surfacing them as 200 would hide
// regressions.

export async function POST(req: NextRequest) {
  const b = await parseJson(req, embedRequestBodySchema);
  if (!b.ok) return b.response;
  const body = b.data;

  // MBOX-348 — resolve the owning mailbox (default account when omitted). An
  // unknown account is a caller bug, not transient infra → 400 (consistent with
  // the bad-body-shape contract above), never a silent 200.
  const acct = await resolveIngestAccountId({
    account_id: body.account_id,
    account_email: body.account_email,
  });
  if (!acct.ok) {
    return NextResponse.json(
      { ok: false, message_id: body.message_id, reason: acct.reason },
      { status: 400 },
    );
  }

  const excerpt = buildBodyExcerpt(body.body);
  const input = buildEmbeddingInput(body.subject ?? null, excerpt);
  if (!input.trim()) {
    return NextResponse.json({
      ok: false,
      message_id: body.message_id,
      reason: 'empty_input',
    });
  }

  const vector = await embedText(input);
  if (!vector) {
    return NextResponse.json({
      ok: false,
      message_id: body.message_id,
      reason: 'embed_unavailable',
    });
  }

  const upsert = await upsertEmailPoint(vector, {
    message_id: body.message_id,
    thread_id: body.thread_id ?? null,
    // STAQPRO-191 — symmetric with retrieve.ts. Outbound rows from
    // MailBOX-Send carry 'sender' as either Gmail-shaped 'Name <addr>'
    // or bare addr depending on the n8n node config; normalize both.
    sender: normalizeSender(body.sender),
    recipient: body.recipient,
    subject: body.subject ?? null,
    body_excerpt: excerpt,
    sent_at: body.sent_at,
    direction: body.direction,
    classification_category: body.classification_category ?? null,
    // STAQPRO-191 — single-persona appliances all seed 'default'. Future
    // multi-persona ingestion will plumb persona_key through the schema.
    persona_key: 'default',
    // MBOX-348 — the resolved owning account for this point.
    account_id: acct.account_id,
  });

  if (!upsert.ok) {
    return NextResponse.json({
      ok: false,
      message_id: body.message_id,
      reason: `qdrant_upsert_failed: ${upsert.reason ?? 'unknown'}`,
    });
  }

  return NextResponse.json({
    ok: true,
    message_id: body.message_id,
    point_id: upsert.point_id,
  });
}
