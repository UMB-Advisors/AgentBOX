import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { providerForKind } from '@/lib/mail/providers';
import { parseJson } from '@/lib/middleware/validate';
import { resolveIngestAccountId } from '@/lib/queries-accounts';
import { embedText } from '@/lib/rag/embed';
import { buildBodyExcerpt, buildEmbeddingInput } from '@/lib/rag/excerpt';
import { normalizeSender, upsertEmailPoint } from '@/lib/rag/qdrant';
import { inboxMessageInsertBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

// STAQPRO-135 — n8n ↔ dashboard ↔ Postgres ownership boundary refactor.
//
// Replaces the legacy n8n `Insert Inbox (skip dupes)` Postgres node so n8n no
// longer writes to `mailbox.inbox_messages` directly. The dashboard becomes
// the single writer for the schema; n8n shrinks to a Gmail / Ollama / HTTP
// adapter.
//
// Response shape — LOCKED contract (downstream `MailBOX-Classify > Load Inbox
// Row` reads `$json.id`; do not break this without coordinating the n8n
// workflow JSON change in the same PR):
//
//   { id: number, message_id: string, created: boolean }
//
// `created` distinguishes a new insert from a dedupe-on-message_id skip via
// the postgres `xmax = 0` trick. xmax is 0 for tuples freshly inserted in the
// current transaction; non-zero on rows that were UPDATE-touched (which is
// what `ON CONFLICT DO UPDATE SET message_id = EXCLUDED.message_id` does to
// force the existing row's `id` into RETURNING). The no-op self-update is
// safe because `mailbox.inbox_messages` has no triggers and no `updated_at`
// column to bump.

export async function POST(req: NextRequest) {
  const b = await parseJson(req, inboxMessageInsertBodySchema);
  if (!b.ok) return b.response;
  const { provider, message_id, received_at, account_id, account_email, ...rest } = b.data;

  // MBOX-348 — resolve the target mailbox. Omitted by the legacy single-account
  // path (→ default account); set explicitly by the multi-account fan-out. An
  // unknown account is a fan-out misconfiguration → 400 (fail loud rather than
  // mis-file one identity's mail under another).
  const acct = await resolveIngestAccountId({ account_id, account_email });
  if (!acct.ok) {
    return NextResponse.json({ error: acct.reason }, { status: 400 });
  }
  const resolvedAccountId = acct.account_id;

  // MBOX-357 (P1 T5) — non-Gmail transports (IMAP today) send raw header fields
  // and the dashboard normalizes server-side via the MailProvider seam. The
  // load-bearing transform is thread_id SYNTHESIS: IMAP has no native thread id,
  // so providerForKind('imap').normalize() hashes the References/In-Reply-To
  // chain root into a stable key (FR-MP-1). Gmail (the default + un-changed
  // path) already arrives with mapped columns + a native threadId, so it skips
  // normalization entirely — the locked STAQPRO-135 contract is preserved.
  const norm =
    provider === 'gmail'
      ? null
      : providerForKind(provider).normalize({
          message_id,
          from_addr: rest.from_addr,
          to_addr: rest.to_addr,
          subject: rest.subject,
          body: rest.body,
          in_reply_to: rest.in_reply_to,
          references: rest.references,
          received_at,
          direction: 'inbound',
        });

  const msgId = norm ? norm.provider_message_id || message_id : message_id;
  const threadId = norm ? (norm.thread_id ?? '') : rest.thread_id;
  const fromAddr = norm ? norm.from_addr : rest.from_addr;
  const toAddr = norm ? norm.to_addr : rest.to_addr;
  const subject = norm ? norm.subject : rest.subject;
  const snippet = norm ? norm.body.slice(0, 200) : rest.snippet;
  const body = norm ? norm.body : rest.body;
  const inReplyTo = norm ? (norm.in_reply_to ?? '') : rest.in_reply_to;
  const references = norm ? (norm.references ?? '') : rest.references;
  // received_at is optional; empty/blank → omit the column so it lands NULL
  // rather than crashing the TIMESTAMPTZ insert (mirror the Gmail-path guard).
  const effectiveReceivedAt = norm
    ? norm.received_at.trim()
      ? norm.received_at
      : undefined
    : received_at;

  try {
    const db = getKysely();
    const row = await db
      .insertInto('inbox_messages')
      .values({
        message_id: msgId,
        account_id: resolvedAccountId,
        thread_id: threadId,
        from_addr: fromAddr,
        to_addr: toAddr,
        subject,
        snippet,
        body,
        in_reply_to: inReplyTo,
        references,
        ...(effectiveReceivedAt !== undefined ? { received_at: effectiveReceivedAt } : {}),
      })
      // MBOX-348 — dedup is per (account_id, message_id): the same Gmail message
      // can legitimately land in two connected inboxes. xmax=0 still discriminates
      // a fresh insert from a dedupe-on-conflict skip.
      .onConflict((oc) =>
        oc.columns(['account_id', 'message_id']).doUpdateSet((eb) => ({
          message_id: eb.ref('excluded.message_id'),
        })),
      )
      .returning(['id', 'message_id', sql<boolean>`xmax = 0`.as('created')])
      .executeTakeFirstOrThrow();

    // STAQPRO-190 — fire-and-forget embed + Qdrant upsert for newly-inserted
    // inbox rows. Skipped on dedup (created=false) since the point already
    // exists with deterministic id (idempotent on re-run anyway, but skipping
    // saves an Ollama call per 5-min Gmail poll cycle).
    //
    // Failure is silent on purpose: RAG is augmentation, not gate. The
    // response to n8n must not depend on Qdrant/Ollama health, otherwise a
    // momentarily-down RAG stack stalls the draft pipeline.
    if (row.created) {
      void embedAndUpsertInbound({
        message_id: row.message_id,
        account_id: resolvedAccountId,
        thread_id: threadId || null,
        sender: fromAddr,
        recipient: toAddr,
        subject: subject || null,
        body,
        sent_at: effectiveReceivedAt ?? new Date().toISOString(),
      });
    }

    return NextResponse.json({
      id: row.id,
      message_id: row.message_id,
      created: row.created,
    });
  } catch (error) {
    console.error('POST /api/internal/inbox-messages failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

interface EmbedInboundParams {
  message_id: string;
  account_id: number;
  thread_id: string | null;
  sender: string;
  recipient: string;
  subject: string | null;
  body: string;
  sent_at: string;
}

async function embedAndUpsertInbound(params: EmbedInboundParams): Promise<void> {
  try {
    const excerpt = buildBodyExcerpt(params.body);
    const input = buildEmbeddingInput(params.subject, excerpt);
    if (!input.trim()) return;
    const vector = await embedText(input);
    if (!vector) return;
    await upsertEmailPoint(vector, {
      message_id: params.message_id,
      thread_id: params.thread_id,
      // STAQPRO-191 — symmetric with retrieve.ts normalization. Without
      // this, 'Name <addr@host>' inbounds never match a retrieval filter
      // built from the bare 'addr@host'.
      sender: normalizeSender(params.sender),
      recipient: params.recipient,
      subject: params.subject,
      body_excerpt: excerpt,
      sent_at: params.sent_at,
      direction: 'inbound',
      classification_category: null,
      // STAQPRO-191 — single-persona appliances all seed 'default'. When
      // multi-persona ships, this will be the mailbox.persona.customer_key
      // for whichever mailbox the inbound landed in.
      persona_key: 'default',
      // MBOX-348 — the resolved ingestion account for this inbound.
      account_id: params.account_id,
    });
  } catch (err) {
    console.error('[rag] inbound embed/upsert failed (non-fatal):', err);
  }
}
