// dashboard/lib/onboarding/gmail-history-backfill.ts
//
// STAQPRO-193 — Gmail Sent backfill orchestrator. Reusable library function
// behind both the CLI script (`scripts/gmail-history-backfill.ts`) and the
// onboarding HTTP route (`app/api/onboarding/backfill/route.ts`).
//
// Flow per the discuss-comment Locked Decisions:
//
//   1. Call MailBOX-FetchHistory webhook with { days_lookback, max_messages }.
//   2. For each returned thread, walk messages in chronological order and
//      emit (inbound_immediately_before_reply, my_reply) pairs — one pair
//      per outbound message authored by self.
//   3. UPSERT inbound rows into mailbox.inbox_messages on message_id.
//      UPSERT reply rows into mailbox.sent_history on message_id (source =
//      'backfill' per migration 011).
//   4. Embedding + Qdrant upsert is a separate step: the existing
//      rag-backfill.ts re-runs against the seeded rows. This module does
//      NOT call embedText / Qdrant — keeps the backfill phases decoupled.
//
// Privacy: bodies are NEVER logged. Only message_ids and aggregate counts.
// PII scrubbing happens later, inside buildBodyExcerpt during embedding —
// the source-of-truth Postgres columns hold the raw body intentionally.

import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db/schema';

// Shape of the response from MailBOX-FetchHistory webhook. The n8n workflow
// returns an array of thread objects (one per unique threadId in the sent
// folder window). Each thread has the Gmail thread shape: messages[] with
// id, threadId, payload.headers, payload.parts, etc.
export interface FetchHistoryThread {
  id: string;
  messages: GmailMessage[];
  // n8n's Gmail node decorates threads with sender/subject/etc. at the top
  // level; we ignore those and parse from messages[] instead so the shape
  // stays portable.
  [k: string]: unknown;
}

export interface FetchHistoryResponse {
  ok: boolean;
  days_lookback: number;
  after_date: string;
  thread_count: number;
  threads: FetchHistoryThread[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string; // ms since epoch as string
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPayload;
}

export interface GmailPayload {
  headers?: Array<{ name: string; value: string }>;
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
}

export interface ReplyPair {
  // The inbound message that prompted the reply (most recent prior message
  // in the same thread sent by someone else).
  inbound: ParsedMessage;
  // The operator's reply.
  reply: ParsedMessage;
}

export interface ParsedMessage {
  message_id: string; // Gmail message id (the `id` field, NOT the RFC 5322 Message-ID header)
  rfc822_message_id: string | null;
  thread_id: string;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  body: string;
  sent_at: string; // ISO 8601
  in_reply_to: string | null;
  references: string | null;
}

export interface BackfillCounts {
  threads_seen: number;
  pairs_extracted: number;
  inbox_upserts: number;
  inbox_skipped_existing: number;
  sent_history_upserts: number;
  sent_history_skipped_existing: number;
  malformed: number;
}

export interface BackfillOptions {
  days_lookback: number;
  max_messages?: number;
  // The operator's email address — used to identify which messages in a
  // thread are "my reply" vs inbound. Matched case-insensitively against
  // the From header.
  operator_email: string;
  // n8n webhook URL. Defaults to internal docker DNS.
  fetch_history_url?: string;
}

// Pull the value of a single header (case-insensitive) from a Gmail payload.
function header(payload: GmailPayload | undefined, name: string): string | null {
  if (!payload?.headers) return null;
  const lower = name.toLowerCase();
  for (const h of payload.headers) {
    if (h.name?.toLowerCase() === lower) return h.value ?? null;
  }
  return null;
}

// MailBOX-FetchHistory's n8n workflow flattens common headers (From, To,
// Subject, Message-Id, In-Reply-To, References) onto the message object
// itself instead of preserving the standard `payload.headers[]` array. This
// helper tries the standard shape first, then falls back to the top-level
// field, so the parser tolerates either contract.
function messageHeader(msg: GmailMessage, name: string): string | null {
  const fromPayload = header(msg.payload, name);
  if (fromPayload !== null) return fromPayload;
  const top = (msg as unknown as Record<string, unknown>)[name];
  return typeof top === 'string' ? top : null;
}

// Walk a Gmail payload tree looking for the best body text. Prefers
// text/plain; falls back to text/html stripped of tags.
function extractBody(payload: GmailPayload | undefined): string {
  if (!payload) return '';
  // Inline body on the leaf node.
  const direct = decodeBase64Url(payload.body?.data);
  if (direct && payload.mimeType?.startsWith('text/plain')) return direct;

  if (payload.parts && payload.parts.length > 0) {
    // Prefer text/plain anywhere in the tree.
    const plain = findPart(payload, (p) => p.mimeType === 'text/plain');
    if (plain) {
      const data = decodeBase64Url(plain.body?.data);
      if (data) return data;
    }
    const html = findPart(payload, (p) => p.mimeType === 'text/html');
    if (html) {
      const data = decodeBase64Url(html.body?.data);
      if (data) return stripHtml(data);
    }
  }

  if (direct && payload.mimeType?.startsWith('text/html')) return stripHtml(direct);
  return direct;
}

function findPart(payload: GmailPayload, pred: (p: GmailPayload) => boolean): GmailPayload | null {
  if (pred(payload)) return payload;
  if (!payload.parts) return null;
  for (const child of payload.parts) {
    const hit = findPart(child, pred);
    if (hit) return hit;
  }
  return null;
}

function decodeBase64Url(data: string | undefined): string {
  if (!data) return '';
  try {
    const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Parse a single From header value. Gmail's payload.headers stores the raw
// RFC 2822 form: `Name <addr@host>` or `addr@host`. We want the bare
// address, lowercased, for comparison against operator_email.
function parseAddress(value: string | null): string {
  if (!value) return '';
  const m = value.match(/<([^>]+)>/);
  return (m?.[1] ?? value).trim().toLowerCase();
}

// Parse a single Gmail message into our internal shape.
export function parseGmailMessage(msg: GmailMessage): ParsedMessage | null {
  if (!msg.id || !msg.threadId) return null;
  const from = parseAddress(messageHeader(msg, 'From'));
  const to = parseAddress(messageHeader(msg, 'To'));
  const subject = messageHeader(msg, 'Subject');
  const inReplyTo = messageHeader(msg, 'In-Reply-To');
  const references = messageHeader(msg, 'References');
  const rfcMsgId = messageHeader(msg, 'Message-ID') ?? messageHeader(msg, 'Message-Id');
  const body = extractBody(msg.payload);
  const sentAtMs = msg.internalDate ? Number(msg.internalDate) : null;
  const sentAt =
    sentAtMs && Number.isFinite(sentAtMs)
      ? new Date(sentAtMs).toISOString()
      : new Date().toISOString();
  return {
    message_id: msg.id,
    rfc822_message_id: rfcMsgId,
    thread_id: msg.threadId,
    from_addr: from,
    to_addr: to,
    subject,
    body,
    sent_at: sentAt,
    in_reply_to: inReplyTo,
    references,
  };
}

// Extract (inbound, reply) pairs from a single thread per Locked Decision #1
// + #2: pair every outbound from self with the most recent prior message
// from someone else. Multi-reply threads emit one pair per outbound.
export function extractReplyPairs(thread: FetchHistoryThread, operatorEmail: string): ReplyPair[] {
  const op = operatorEmail.trim().toLowerCase();
  if (!thread.messages || thread.messages.length === 0) return [];
  const parsed = thread.messages
    .map(parseGmailMessage)
    .filter((m): m is ParsedMessage => m !== null)
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at));

  const pairs: ReplyPair[] = [];
  let mostRecentInbound: ParsedMessage | null = null;
  for (const msg of parsed) {
    const isOutbound = msg.from_addr === op;
    if (isOutbound) {
      if (mostRecentInbound) {
        pairs.push({ inbound: mostRecentInbound, reply: msg });
      }
      // Outbound replies don't reset the inbound anchor — if the operator
      // sends two messages back-to-back, both pair against the same prior
      // inbound. Discuss-comment locks "all pairs per thread"; this matches
      // the operator-intent reading.
    } else {
      mostRecentInbound = msg;
    }
  }
  return pairs;
}

// Fetch with retry for n8n webhook calls. Exponential backoff per Locked
// Decision #5 (1s / 4s / 16s, max 3 retries). Only retries on 429 + 5xx.
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export async function callFetchHistory(
  url: string,
  payload: { days_lookback: number; max_messages?: number },
  fetchFn: FetchFn = fetch,
  delayFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<FetchHistoryResponse> {
  // Locked Decision #5: exp backoff 1s/4s/16s, max 3 retries on 429.
  // Retry policy: 429 + 5xx + transport errors. Non-retry: 4xx (client bug).
  const delays = [1000, 4000, 16000];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < delays.length) {
          await delayFn(delays[attempt] ?? 0);
          continue;
        }
        throw new Error(`fetch-history responded ${res.status}`);
      }
      if (!res.ok) {
        // 4xx — caller bug. Don't retry; surface immediately.
        throw new Error(`fetch-history responded ${res.status} (non-retry)`);
      }
      const json = (await res.json()) as FetchHistoryResponse;
      return json;
    } catch (err) {
      // Don't retry non-retry markers — let them propagate.
      if (err instanceof Error && err.message.includes('(non-retry)')) {
        throw err;
      }
      if (attempt < delays.length) {
        await delayFn(delays[attempt] ?? 0);
        continue;
      }
      throw err;
    }
  }
  throw new Error('fetch-history exhausted retries');
}

// UPSERT an inbound message into mailbox.inbox_messages on message_id.
// Returns the upserted row's id + whether it was newly created — the id is
// needed downstream so upsertReply can wire sent_history.inbox_message_id
// (without it, STAQPRO-153's persona extractor LEFT JOINs to NULL on every
// backfill row and exemplars degrade).
export interface UpsertInboundResult {
  result: 'inserted' | 'existing';
  id: number;
}

export async function upsertInbound(
  db: Kysely<DB>,
  msg: ParsedMessage,
): Promise<UpsertInboundResult> {
  const inserted = await db
    .insertInto('inbox_messages')
    .values({
      message_id: msg.message_id,
      thread_id: msg.thread_id,
      from_addr: msg.from_addr || null,
      to_addr: msg.to_addr || null,
      subject: msg.subject,
      body: msg.body || null,
      received_at: msg.sent_at,
      in_reply_to: msg.in_reply_to,
      references: msg.references,
      // Classifier doesn't run on historical data — left as NULL so any
      // future re-classify pass picks them up cleanly.
      classification: null,
      confidence: null,
      classified_at: null,
      model: null,
      snippet: null,
      draft_id: null,
    })
    // MBOX-348 — dedup key reshaped to (account_id, message_id). account_id is
    // omitted from values above so the column DEFAULT (the single connected
    // mailbox = default account) fills it; the onboarding backfill is a
    // single-account flow.
    .onConflict((oc) => oc.columns(['account_id', 'message_id']).doNothing())
    .returning(['id'])
    .executeTakeFirst();

  if (inserted?.id != null) {
    return { result: 'inserted', id: inserted.id };
  }

  // ON CONFLICT DO NOTHING fired — fetch the existing row's id so the caller
  // can wire the FK in sent_history.
  const existing = await db
    .selectFrom('inbox_messages')
    .select(['id'])
    .where('message_id', '=', msg.message_id)
    .executeTakeFirstOrThrow();
  return { result: 'existing', id: existing.id };
}

// UPSERT an outbound reply into mailbox.sent_history on message_id (the
// migration-011 partial unique index). Backfill rows are stamped with
// source = 'backfill'; classification_category is forced to 'unknown' to
// satisfy the existing CHECK constraint without inventing categories.
export async function upsertReply(
  db: Kysely<DB>,
  inbound: ParsedMessage,
  reply: ParsedMessage,
  inbox_message_id: number,
): Promise<'inserted' | 'existing'> {
  const r = await db
    .insertInto('sent_history')
    .values({
      message_id: reply.message_id,
      draft_id: null,
      inbox_message_id,
      from_addr: reply.from_addr,
      to_addr: reply.to_addr,
      subject: reply.subject,
      body_text: inbound.body || null,
      thread_id: reply.thread_id,
      draft_original: null,
      draft_sent: reply.body || '',
      draft_source: 'local',
      classification_category: 'unknown',
      classification_confidence: 0,
      sent_at: reply.sent_at,
      source: 'backfill',
    })
    // Target the partial unique index. MBOX-348 reshaped it to
    // (account_id, message_id) WHERE message_id IS NOT NULL; account_id is
    // omitted from values above so the column DEFAULT (default account) fills
    // it — the onboarding backfill is single-account.
    .onConflict((oc) =>
      oc.columns(['account_id', 'message_id']).where('message_id', 'is not', null).doNothing(),
    )
    .executeTakeFirst();
  const affected = r?.numInsertedOrUpdatedRows ?? BigInt(0);
  return affected === BigInt(0) ? 'existing' : 'inserted';
}

export interface RunBackfillDeps {
  db: Kysely<DB>;
  fetchFn?: FetchFn;
  delayFn?: (ms: number) => Promise<void>;
}

// Run the full backfill end-to-end. The caller decides whether to chain
// rag-backfill.ts after this completes (the CLI does; the HTTP route does
// not — it returns the counts and lets the operator kick off embedding).
export async function runGmailHistoryBackfill(
  opts: BackfillOptions,
  deps: RunBackfillDeps,
): Promise<BackfillCounts> {
  const { db, fetchFn, delayFn } = deps;
  const url = opts.fetch_history_url ?? 'http://n8n:5678/webhook/mailbox-fetch-history';

  const counts: BackfillCounts = {
    threads_seen: 0,
    pairs_extracted: 0,
    inbox_upserts: 0,
    inbox_skipped_existing: 0,
    sent_history_upserts: 0,
    sent_history_skipped_existing: 0,
    malformed: 0,
  };

  const response = await callFetchHistory(
    url,
    { days_lookback: opts.days_lookback, max_messages: opts.max_messages },
    fetchFn,
    delayFn,
  );
  counts.threads_seen = response.threads.length;

  for (const thread of response.threads) {
    let pairs: ReplyPair[];
    try {
      pairs = extractReplyPairs(thread, opts.operator_email);
    } catch {
      counts.malformed += 1;
      continue;
    }
    counts.pairs_extracted += pairs.length;
    for (const pair of pairs) {
      try {
        const inboundResult = await upsertInbound(db, pair.inbound);
        if (inboundResult.result === 'inserted') counts.inbox_upserts += 1;
        else counts.inbox_skipped_existing += 1;

        const replyResult = await upsertReply(db, pair.inbound, pair.reply, inboundResult.id);
        if (replyResult === 'inserted') counts.sent_history_upserts += 1;
        else counts.sent_history_skipped_existing += 1;
      } catch (err) {
        counts.malformed += 1;
        // Log message_ids only — never the body.
        console.error(
          `[gmail-history-backfill] upsert failed for thread=${thread.id} reply=${pair.reply.message_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return counts;
}
