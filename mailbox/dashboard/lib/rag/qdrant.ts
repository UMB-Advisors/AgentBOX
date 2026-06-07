// dashboard/lib/rag/qdrant.ts
//
// STAQPRO-190 — thin Qdrant client for the `email_messages` collection.
// Wraps the two HTTP calls we need: upsert one point and search by vector.
// Idempotency: each Gmail `message_id` deterministically maps to a single
// point UUID (sha256-derived), so re-upserting the same message_id is a
// no-op-equivalent overwrite rather than creating duplicate points. This
// is what the issue calls out as the "Idempotent on `message_id`" acceptance
// criterion.
//
// Failure mode: every method returns a tagged result instead of throwing,
// so callers can degrade gracefully (RAG is augmentation, not gate).

import { createHash } from 'node:crypto';

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333';
const COLLECTION = 'email_messages';
const QDRANT_TIMEOUT_MS = Number(process.env.QDRANT_TIMEOUT_MS ?? 5000);

export type Direction = 'inbound' | 'outbound';

// STAQPRO-191 — symmetric sender normalization for the
// payload.sender == inbound.from_addr counterparty filter. Gmail headers
// arrive as either 'Display Name <addr@host>' or already-bare 'addr@host';
// without symmetric normalization at ingestion AND retrieval, half of
// senders silently miss the filter and return zero hits. Both sides MUST
// import this single normalizer — do not inline.
//
// Pure function (no IO). Returns '' on empty/whitespace input so callers
// can short-circuit instead of throwing.
export function normalizeSender(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // 'Name <addr@host>' → 'addr@host'; lone 'addr@host' passes through.
  const angled = trimmed.match(/<([^>]+)>/);
  return (angled ? angled[1] : trimmed).trim().toLowerCase();
}

export interface EmailPointPayload {
  message_id: string;
  thread_id: string | null;
  sender: string;
  recipient: string;
  subject: string | null;
  body_excerpt: string;
  sent_at: string; // ISO 8601
  direction: Direction;
  classification_category: string | null;
  // STAQPRO-191 — persona scoping for multi-mailbox appliances. Tenant
  // boundary is hardware (one Jetson per customer); this field discriminates
  // multiple mailboxes inside a single appliance. All current ingestion
  // paths seed 'default'; future multi-persona work writes the persona's
  // mailbox.persona.customer_key.
  persona_key: string;
  // MBOX-348 (MBOX-162 V1) — the mailbox.accounts row this point belongs to.
  // Mirrors the SQL account_id dimension into the vector store so V2 per-account
  // RAG isolation can filter recall by account. Existing points are re-tagged to
  // the default account by scripts/retag-qdrant-account-id.ts.
  // NOTE (V2 follow-up): the point id is still derived from message_id alone
  // (pointIdFromMessageId), so the same Gmail message ingested into two accounts
  // collides on one point. Acceptable for V1 (cross-account same-message is rare
  // and retrieval is sender-filtered today); per-account RAG isolation (V2) must
  // key the point id on (account_id, message_id).
  account_id: number;
}

export interface UpsertResult {
  ok: boolean;
  point_id: string;
  reason?: string;
}

// Deterministic UUID-v4-shaped string from message_id, suitable for Qdrant
// point IDs (Qdrant accepts integers or UUIDs; UUID is chosen to avoid the
// 64-bit integer collision space across mailboxes). sha256 → first 32 hex
// chars → 8-4-4-4-12 dash format with version/variant nibbles set per RFC
// 4122 §4.4 so the result is a syntactically valid UUID v4.
export function pointIdFromMessageId(messageId: string): string {
  return uuidFromSha256(createHash('sha256').update(messageId).digest('hex'));
}

// MBOX-352 (MBOX-162 V2) — account-scoped point id. The same Gmail message can
// legitimately land in two connected inboxes (addressed to founder@ and
// consulting@); keying the point on message_id alone would collide them onto a
// single Qdrant point and cross-contaminate per-account recall. Deriving the id
// from `${account_id}:${message_id}` gives each account its own point.
//
// Migration story: existing single-account points predate this and are keyed by
// message_id alone. They keep working — the account_id FILTER (payload, tagged
// by V1's retag) does the isolation regardless of the point id, and self-exclude
// (retrieve.ts) checks BOTH the legacy and account-scoped ids so an old point is
// still dropped. scripts/rekey-qdrant-account-point-ids.ts re-points them to the
// new scheme; until it runs (moot while accounts=1) the two schemes coexist.
export function pointIdFromAccountMessage(accountId: number, messageId: string): string {
  return uuidFromSha256(createHash('sha256').update(`${accountId}:${messageId}`).digest('hex'));
}

// Shared 8-4-4-4-12 RFC-4122-§4.4 derivation: first 32 hex chars of a sha256
// digest with the version (4) and variant (8/9/a/b) nibbles forced so the
// result is a syntactically valid UUID v4 that Qdrant accepts as a point id.
function uuidFromSha256(h: string): string {
  // Set version (4) and variant (8/9/a/b) bits per RFC 4122.
  const v = `4${h.slice(13, 16)}`;
  const variantNibble = ((Number.parseInt(h[16] ?? '0', 16) & 0b0011) | 0b1000).toString(16);
  const r = `${variantNibble}${h.slice(17, 20)}`;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${r}-${h.slice(20, 32)}`;
}

interface QdrantResponseBody {
  status?: string | { error?: string };
  result?: unknown;
}

async function qdrantRequest(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: QdrantResponseBody | null }> {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(QDRANT_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: QdrantResponseBody | null;
  try {
    json = text ? (JSON.parse(text) as QdrantResponseBody) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export async function upsertEmailPoint(
  vector: number[],
  payload: EmailPointPayload,
): Promise<UpsertResult> {
  // MBOX-352 (MBOX-162 V2) — account-scoped point id so the same Gmail message
  // landing in two connected inboxes occupies two distinct points instead of
  // colliding on one. payload.account_id is always present (required field,
  // resolved by the ingestion routes). Legacy points keyed by message_id alone
  // are migrated by scripts/rekey-qdrant-account-point-ids.ts.
  const pointId = pointIdFromAccountMessage(payload.account_id, payload.message_id);
  try {
    const r = await qdrantRequest('PUT', `/collections/${COLLECTION}/points`, {
      points: [{ id: pointId, vector, payload }],
    });
    if (r.status !== 200) {
      const errBody = r.json?.status;
      const reason = typeof errBody === 'string' ? errBody : (errBody?.error ?? `HTTP ${r.status}`);
      return { ok: false, point_id: pointId, reason };
    }
    return { ok: true, point_id: pointId };
  } catch (error) {
    return {
      ok: false,
      point_id: pointId,
      reason: error instanceof Error ? error.message : 'unknown',
    };
  }
}

export interface SearchHit {
  id: string;
  score: number;
  payload: EmailPointPayload;
}

export interface SearchResult {
  ok: boolean;
  hits: SearchHit[];
  reason?: string;
}

export interface SearchOptions {
  limit?: number;
  senderFilter?: string;
  // STAQPRO-221 — recipient filter for the outbound-voice-priming half of
  // the two-pass retrieval (H2). Used together with senderFilter to scope
  // outbound history to messages from the operator TO the current
  // counterparty (we wrote X to them); without it, outbound search would
  // return everything the operator ever sent, washing the topical signal.
  // ANDed with senderFilter when both are set.
  recipientFilter?: string;
  // STAQPRO-191 — persona scoping. When set, ANDed with senderFilter so a
  // multi-persona appliance only retrieves history from the persona that
  // owns the in-flight draft. When unset, no persona filter is applied
  // (single-persona appliances retain previous behavior).
  personaKey?: string;
  // STAQPRO-219 — drop the inbound's own backfilled twin from search via
  // Qdrant's must_not + has_id filter primitive (Qdrant 1.13+). Without
  // this, the inbound's own embedding scores 1.000 against itself and
  // burns one top-k slot on every query. Caller passes the inbound's own
  // deterministic point UUID(s). MBOX-352: a list, because a message can have
  // both a legacy (message_id-keyed) and an account-scoped point id during the
  // pre-rekey window — both must be excluded.
  excludePointIds?: string[];
  // MBOX-352 (MBOX-162 V2) — per-account isolation. When set, ANDed with the
  // sender/persona filters so a multi-mailbox appliance only retrieves history
  // belonging to the account that owns the in-flight draft. Email points carry
  // payload.account_id (V1 migration 033 + retag), so this is safe to apply on
  // a single-account box too — the default account matches every point. When
  // unset (eval harness, legacy callers), no account filter is applied.
  accountFilter?: number;
  // STAQPRO-222 (H3) — drop every point whose payload.thread_id matches the
  // inbound's thread_id. Same-thread refs duplicate context the drafter
  // already has in the inbound body's quoted-history chain. ANDed with the
  // must_not.has_id clause when both are set (Qdrant's must_not entries are
  // OR-of-mismatch — i.e. a point is excluded if any clause matches).
  // payload.thread_id is one of the indexed fields per the STAQPRO-188
  // bootstrap (root CLAUDE.md service topology).
  excludeThreadId?: string;
}

// Search by vector with optional hard filters on payload.sender and
// payload.persona_key. Used by STAQPRO-191 retrieval at draft time. For now
// this lives in the same module as the upsert path so consumers have one
// rag/qdrant import.
export async function searchByVector(
  vector: number[],
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const limit = opts.limit ?? 5;
  const must: Array<{ key: string; match: { value: string | number } }> = [];
  if (opts.senderFilter) must.push({ key: 'sender', match: { value: opts.senderFilter } });
  // STAQPRO-221 — recipient filter is normalized at the call site (same
  // normalizeSender() flow); we just pass through here. Lowercase /
  // angle-bracket stripping has already happened.
  if (opts.recipientFilter) must.push({ key: 'recipient', match: { value: opts.recipientFilter } });
  if (opts.personaKey) must.push({ key: 'persona_key', match: { value: opts.personaKey } });
  // MBOX-352 (MBOX-162 V2) — per-account hard filter. Integer match on
  // payload.account_id; ANDed with the sender/persona filters above.
  if (opts.accountFilter !== undefined) {
    must.push({ key: 'account_id', match: { value: opts.accountFilter } });
  }
  // STAQPRO-219 — must_not.has_id drops the inbound's own UUID(s) from results.
  // STAQPRO-222 (H3) — must_not.thread_id drops every point in the same
  // conversation thread. Qdrant treats heterogeneous must_not clauses as
  // an OR-of-mismatch: a point is excluded if ANY clause matches it.
  type MustNotClause = { has_id: string[] } | { key: string; match: { value: string } };
  const must_not: MustNotClause[] = [];
  if (opts.excludePointIds && opts.excludePointIds.length > 0) {
    must_not.push({ has_id: opts.excludePointIds });
  }
  if (opts.excludeThreadId) {
    must_not.push({ key: 'thread_id', match: { value: opts.excludeThreadId } });
  }
  const filter =
    must.length > 0 || must_not.length > 0
      ? {
          ...(must.length > 0 ? { must } : {}),
          ...(must_not.length > 0 ? { must_not } : {}),
        }
      : undefined;
  try {
    const r = await qdrantRequest('POST', `/collections/${COLLECTION}/points/search`, {
      vector,
      limit,
      with_payload: true,
      ...(filter ? { filter } : {}),
    });
    if (r.status !== 200) {
      return { ok: false, hits: [], reason: `HTTP ${r.status}` };
    }
    const result = r.json?.result;
    if (!Array.isArray(result)) {
      return { ok: false, hits: [], reason: 'unexpected response shape' };
    }
    const hits: SearchHit[] = result.map((h) => {
      const hit = h as { id: string; score: number; payload: EmailPointPayload };
      return { id: hit.id, score: hit.score, payload: hit.payload };
    });
    return { ok: true, hits };
  } catch (error) {
    return {
      ok: false,
      hits: [],
      reason: error instanceof Error ? error.message : 'unknown',
    };
  }
}

// STAQPRO-331 #2 — fetch points by their UUIDs (e.g., the UUIDs stored in
// drafts.rag_context_refs). Used to reverse the one-way
// pointIdFromMessageId hash for the RAG-attribution UI: given a draft's
// retrieved refs, get back the source messages' payloads so we can render
// sender / subject / snippet to the operator.
export interface GetPointsResult {
  ok: boolean;
  points: Array<{ id: string; payload: EmailPointPayload }>;
  reason?: string;
}

export async function getPointsByIds(ids: readonly string[]): Promise<GetPointsResult> {
  if (ids.length === 0) return { ok: true, points: [] };
  try {
    const r = await qdrantRequest('POST', `/collections/${COLLECTION}/points`, {
      ids: [...ids],
      with_payload: true,
    });
    if (r.status !== 200) {
      return { ok: false, points: [], reason: `HTTP ${r.status}` };
    }
    const result = r.json?.result;
    if (!Array.isArray(result)) {
      return { ok: false, points: [], reason: 'unexpected response shape' };
    }
    const points = result.map((p) => {
      const point = p as { id: string; payload: EmailPointPayload };
      return { id: point.id, payload: point.payload };
    });
    return { ok: true, points };
  } catch (error) {
    return {
      ok: false,
      points: [],
      reason: error instanceof Error ? error.message : 'unknown',
    };
  }
}
