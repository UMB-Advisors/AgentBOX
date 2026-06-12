// dashboard/app/api/drafts/[id]/rag-refs/route.ts
//
// STAQPRO-331 #2 + STAQPRO-333 — resolve a draft's RAG context (email refs
// AND KB refs) back to source documents so the queue UI can render a
// "Sources used" panel discriminated by source type.
//
// drafts.rag_context_refs is a jsonb array of UUIDs in the `email_messages`
// collection; drafts.kb_context_refs is a jsonb array of UUIDs in the
// `kb_documents` collection. Each draft can carry both, either, or neither.
// We batch-resolve each branch independently and tag the response refs
// with source: 'email' | 'kb' so the client can render appropriately.
//
// Per the route's existing semantics: the email branch's rag_retrieval_reason
// discriminates an empty email refs array (cloud_gated / no_hits / etc).
// The KB branch does NOT currently have a parallel reason column — see the
// draft-prompt route comment "rag_retrieval_reason carries the EMAIL
// retrieval reason for backward-compat with STAQPRO-192's existing eval
// surface. The KB reason currently lives only in the response body." When
// kb_context_refs is empty we simply return [] for the kb refs with no
// companion reason; the UI's "no KB sources retrieved" copy is unconditional.

import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseParams } from '@/lib/middleware/validate';
import { getKbPointsByIds } from '@/lib/rag/kb-qdrant';
import { getPointsByIds } from '@/lib/rag/qdrant';
import { idParamSchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

interface EmailSourceRef {
  source: 'email';
  point_id: string;
  message_id: string;
  sender: string;
  recipient: string;
  subject: string | null;
  body_excerpt: string;
  sent_at: string;
  direction: 'inbound' | 'outbound';
  classification_category: string | null;
}

interface KbSourceRef {
  source: 'kb';
  point_id: string;
  doc_id: number;
  doc_title: string;
  chunk_index: number;
  mime_type: string;
  excerpt: string;
  uploaded_at: string;
}

type SourceRef = EmailSourceRef | KbSourceRef;

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const db = getKysely();
  const row = await db
    .selectFrom('drafts')
    .select(['rag_context_refs', 'rag_retrieval_reason', 'kb_context_refs'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return NextResponse.json({ error: 'draft_not_found' }, { status: 404 });
  }

  // jsonb arrays are typed as `unknown` by kysely-codegen; defensively
  // validate each is an array of strings before passing to Qdrant.
  const rawEmailRefs = row.rag_context_refs;
  const emailPointIds = Array.isArray(rawEmailRefs)
    ? rawEmailRefs.filter((r): r is string => typeof r === 'string')
    : [];
  const rawKbRefs = row.kb_context_refs;
  const kbPointIds = Array.isArray(rawKbRefs)
    ? rawKbRefs.filter((r): r is string => typeof r === 'string')
    : [];

  // Two independent Qdrant round-trips in parallel — each can succeed or
  // fail without affecting the other. Empty arrays skip the call (the
  // helper's own empty-input fast-path also handles this; the explicit
  // skip here keeps the response shape predictable and avoids confusing
  // "ok: true with no points" responses in logs).
  const [emailResult, kbResult] = await Promise.all([
    emailPointIds.length > 0 ? getPointsByIds(emailPointIds) : Promise.resolve(null),
    kbPointIds.length > 0 ? getKbPointsByIds(kbPointIds) : Promise.resolve(null),
  ]);

  // Resolve email branch — preserve stored order even if Qdrant returns
  // out-of-order (same invariant the existing email-only path enforced).
  let emailRefs: EmailSourceRef[] = [];
  let qdrant_error: string | undefined;
  let unresolved_point_ids: string[] | undefined;
  if (emailResult) {
    if (emailResult.ok) {
      const byId = new Map(emailResult.points.map((pt) => [pt.id, pt]));
      emailRefs = emailPointIds
        .map((pid) => byId.get(pid))
        .filter(
          (pt): pt is { id: string; payload: (typeof emailResult.points)[number]['payload'] } =>
            pt !== undefined,
        )
        .map((pt) => ({
          source: 'email' as const,
          point_id: pt.id,
          message_id: pt.payload.message_id,
          sender: pt.payload.sender,
          recipient: pt.payload.recipient,
          subject: pt.payload.subject,
          body_excerpt: pt.payload.body_excerpt,
          sent_at: pt.payload.sent_at,
          direction: pt.payload.direction,
          classification_category: pt.payload.classification_category,
        }));
    } else {
      qdrant_error = emailResult.reason ?? 'unknown';
      unresolved_point_ids = emailPointIds;
    }
  }

  // Resolve KB branch — same ordering invariant, separate failure
  // surface (kb_qdrant_error / kb_unresolved_point_ids).
  let kbRefs: KbSourceRef[] = [];
  let kb_qdrant_error: string | undefined;
  let kb_unresolved_point_ids: string[] | undefined;
  if (kbResult) {
    if (kbResult.ok) {
      const byId = new Map(kbResult.points.map((pt) => [pt.id, pt]));
      kbRefs = kbPointIds
        .map((pid) => byId.get(pid))
        .filter(
          (pt): pt is { id: string; payload: (typeof kbResult.points)[number]['payload'] } =>
            pt !== undefined,
        )
        .map((pt) => ({
          source: 'kb' as const,
          point_id: pt.id,
          doc_id: pt.payload.doc_id,
          doc_title: pt.payload.doc_title,
          chunk_index: pt.payload.chunk_index,
          mime_type: pt.payload.mime_type,
          excerpt: pt.payload.excerpt,
          uploaded_at: pt.payload.uploaded_at,
        }));
    } else {
      kb_qdrant_error = kbResult.reason ?? 'unknown';
      kb_unresolved_point_ids = kbPointIds;
    }
  }

  // Ordering: email first (in stored order), KB second (in stored order).
  // Mirrors the prompt-assembly block ordering in lib/drafting/prompt.ts.
  const refs: SourceRef[] = [...emailRefs, ...kbRefs];

  return NextResponse.json({
    reason: row.rag_retrieval_reason,
    refs,
    ...(qdrant_error ? { qdrant_error, unresolved_point_ids } : {}),
    ...(kb_qdrant_error ? { kb_qdrant_error, kb_unresolved_point_ids } : {}),
  });
}
