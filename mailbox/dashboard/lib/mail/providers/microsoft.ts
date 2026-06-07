// dashboard/lib/mail/providers/microsoft.ts
//
// MBOX-358 (P2 of MBOX-355, multi-provider mail) — MicrosoftGraphProvider: the
// Outlook / Microsoft 365 (Exchange Online) transport behind the MailProvider
// seam (DR-55). The highest-value ICP, landed after the seam was proven on the
// harder IMAP threading case (P1 / MBOX-357).
//
// Like ImapSmtpProvider this file is the DECISION-INDEPENDENT core: normalize,
// thread-id, rate-limit parsing, capabilities — all pure and unit-tested. It
// does NOT decide where Graph I/O runs (an n8n MailBOX-Graph workflow vs a
// dashboard-owned poll loop — the DR-56 crux, same gate IMAP waits on), so the
// transport methods throw NotImplementedYet until that's resolved.
//
// Threading is the EASY case here (contrast IMAP): Graph hands us a native
// `conversationId` (FR-MP-1), so normalizeThreadId is a passthrough exactly like
// Gmail's thread id. The interesting provider-specific work is (a) digging the
// canonical fields out of Graph's nested message JSON and (b) parsing Graph's
// 429 `Retry-After` throttle hint (FR-MP-3).

import type {
  BackfillOptions,
  CanonicalMessage,
  MailAccount,
  MailProvider,
  ProviderCapabilities,
  RateLimitHint,
  SendRequest,
  SendResult,
} from './types';

export class GraphNotImplementedYet extends Error {
  constructor(method: string) {
    super(
      `MicrosoftGraphProvider.${method}() — transport I/O lands after the DR-56 ` +
        `decision (n8n MailBOX-Graph workflow vs dashboard-owned poll loop), the ` +
        `same gate IMAP send waits on. The connect/onboarding flow + provider core ` +
        `ship in P2; operational send/poll is wired alongside the IMAP path.`,
    );
    this.name = 'GraphNotImplementedYet';
  }
}

// Graph 429 throttle clears fast and is almost always accompanied by an explicit
// Retry-After. This conservative default only applies when a throttle is
// detected with NO machine-readable hint — its sole job is to stop an immediate
// re-fire (mirrors the Gmail/IMAP providers).
const DEFAULT_THROTTLE_COOLDOWN_MS = 60 * 1000;

// Graph throttle / service-unavailable signals. 429 TooManyRequests is the
// throttle; 503 ServiceUnavailable also carries Retry-After and warrants a
// backoff. Textual hints cover the cases where only a serialized message survives.
const THROTTLE_RE = /\b(429|503)\b|too\s*many\s*requests|throttl|ApplicationThrottled/i;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// Pull an email address out of either a flattened string ('a@b.com') or Graph's
// nested recipient shape ({ emailAddress: { address: 'a@b.com' } }).
function graphAddr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (isRecord(v) && isRecord(v.emailAddress)) return str(v.emailAddress.address);
  return '';
}

// Graph `toRecipients` is an array of recipient objects; the canonical to_addr
// is single-valued (the pipeline keys reply on it), so take the first. Also
// tolerate a flattened string the n8n caller may pre-extract.
function graphToAddr(raw: Record<string, unknown>): string {
  const flat = str(raw.to_addr ?? raw.to);
  if (flat) return flat;
  const recips = raw.toRecipients;
  if (Array.isArray(recips) && recips.length > 0) return graphAddr(recips[0]);
  return '';
}

// Graph `body` is { contentType: 'html'|'text', content: string }; n8n may
// flatten it to a string. Prefer the full body content, fall back to the
// (truncated) bodyPreview, then snippet. Quote/HTML handling is downstream and
// sender-agnostic (lib/drafting/strip-quoting) — normalize just surfaces text.
function graphBody(raw: Record<string, unknown>): string {
  const body = raw.body;
  if (typeof body === 'string' && body.length > 0) return body;
  if (isRecord(body) && typeof body.content === 'string' && body.content.length > 0) {
    return body.content;
  }
  return str(raw.bodyPreview ?? raw.snippet);
}

// Find an RFC5322 header value in Graph's `internetMessageHeaders`
// ([{ name, value }], present only when the caller $select'd it). Case-insensitive.
function graphHeader(raw: Record<string, unknown>, name: string): string | null {
  const headers = raw.internetMessageHeaders;
  if (!Array.isArray(headers)) return null;
  const target = name.toLowerCase();
  for (const h of headers) {
    if (isRecord(h) && str(h.name).toLowerCase() === target) {
      return strOrNull(h.value);
    }
  }
  return null;
}

function asText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// Graph signals throttling with HTTP 429 (or 503) + a `Retry-After` header in
// delta-SECONDS (occasionally an HTTP-date). The hint can reach us three ways
// depending on the (future) caller: a structured response-like object, an error
// carrying headers, or a serialized text blob. Try each, return a future Date.
function retryAfterFrom(error: unknown): Date | null {
  // 1. Structured: a Headers instance or a plain { 'retry-after': ... } bag,
  //    on the error itself or a nested `.headers` / `.response.headers`.
  const headerVal = extractRetryAfterHeader(error);
  if (headerVal !== null) {
    const fromHeader = parseRetryAfterValue(headerVal);
    if (fromHeader) return fromHeader;
  }
  // 2. Text fallback: "Retry-After: 30" embedded in a serialized error.
  const m = /retry-?after['":\s]+([0-9]{1,6})\b/i.exec(asText(error));
  if (m) {
    const secs = Number(m[1]);
    if (Number.isFinite(secs) && secs >= 0) return new Date(Date.now() + secs * 1000);
  }
  return null;
}

function extractRetryAfterHeader(error: unknown): string | null {
  const sources: unknown[] = [];
  if (isRecord(error)) {
    sources.push(error.headers);
    if (isRecord(error.response)) sources.push(error.response.headers);
  }
  for (const src of sources) {
    if (src == null) continue;
    // Headers (fetch) exposes .get(); a plain object is keyed directly.
    const getter = (src as { get?: unknown }).get;
    if (typeof getter === 'function') {
      const v = (getter as (n: string) => unknown).call(src, 'retry-after');
      if (typeof v === 'string' || typeof v === 'number') return String(v);
    } else if (isRecord(src)) {
      const v = src['retry-after'] ?? src['Retry-After'];
      if (typeof v === 'string' || typeof v === 'number') return String(v);
    }
  }
  return null;
}

// Retry-After is delta-seconds per RFC 7231 (Graph's form) but may be an
// HTTP-date. Parse seconds first, then a date; ignore past deadlines.
function parseRetryAfterValue(raw: string): Date | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return new Date(Date.now() + Number(trimmed) * 1000);
  }
  const asDate = new Date(trimmed);
  if (!Number.isNaN(asDate.getTime()) && asDate.getTime() > Date.now()) return asDate;
  return null;
}

function statusOf(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const s =
    error.status ??
    error.statusCode ??
    (isRecord(error.response) ? error.response.status : undefined);
  return typeof s === 'number' ? s : null;
}

export class MicrosoftGraphProvider implements MailProvider {
  readonly kind = 'microsoft' as const;

  readonly capabilities: ProviderCapabilities = {
    nativeThreading: true, // Graph conversationId is authoritative — see normalizeThreadId.
    push: false, // poll-only in v1; Graph change-notification webhooks deferred (NC-36).
    quoteStrategy: 'outlook', // informational (FR-MP-2); strip-quoting stays sender-agnostic.
  };

  // Map a Graph message → CanonicalMessage. Tolerant of BOTH raw Graph JSON
  // (nested from/toRecipients/body, conversationId, internetMessageHeaders) and
  // the flattened snake_case keys an n8n Build-Payload node may pre-extract.
  normalize(raw: unknown): CanonicalMessage {
    const r = (raw ?? {}) as Record<string, unknown>;
    const msg: CanonicalMessage = {
      // Dedup key. The Graph native message `id` is stable per-mailbox; fall
      // back to the caller-supplied message_id, then the RFC internetMessageId.
      provider_message_id: str(r.message_id ?? r.id ?? r.internetMessageId),
      // Native conversation key; passthrough in normalizeThreadId below.
      thread_id: strOrNull(r.thread_id ?? r.conversationId),
      from_addr: r.from_addr ? str(r.from_addr) : graphAddr(r.from),
      to_addr: graphToAddr(r),
      subject: str(r.subject),
      body: graphBody(r),
      in_reply_to: strOrNull(r.in_reply_to) ?? graphHeader(r, 'In-Reply-To'),
      references: strOrNull(r.references) ?? graphHeader(r, 'References'),
      received_at: str(r.received_at ?? r.receivedDateTime),
      direction: r.direction === 'outbound' ? 'outbound' : 'inbound',
    };
    msg.thread_id = this.normalizeThreadId(msg);
    return msg;
  }

  // Graph provides an authoritative conversationId; canonical thread_id is a
  // passthrough (identical posture to Gmail's native thread id). No synthesis
  // needed — that's the IMAP-only hard case.
  normalizeThreadId(msg: CanonicalMessage): string | null {
    return msg.thread_id;
  }

  // Classify a Graph error as a 429/503 throttle and extract the Retry-After
  // cooldown deadline. Returns until=null when it's not a throttle, or when the
  // throttle carries no hint AND the conservative default is the only signal —
  // we still return a short future deadline in that case to prevent a re-fire.
  parseRateLimit(error: unknown): RateLimitHint {
    const status = statusOf(error);
    const isThrottle = status === 429 || status === 503 || THROTTLE_RE.test(asText(error));
    if (!isThrottle) return { until: null };
    return { until: retryAfterFrom(error) ?? new Date(Date.now() + DEFAULT_THROTTLE_COOLDOWN_MS) };
  }

  // --- Transport I/O: pending the DR-56 decision (see file header). ---
  listNew(
    _account: MailAccount,
    _cursor: unknown,
  ): Promise<{ messages: CanonicalMessage[]; cursor: unknown }> {
    throw new GraphNotImplementedYet('listNew');
  }

  send(_account: MailAccount, _req: SendRequest): Promise<SendResult> {
    throw new GraphNotImplementedYet('send');
  }

  backfillSent(_account: MailAccount, _opts: BackfillOptions): AsyncIterable<CanonicalMessage> {
    throw new GraphNotImplementedYet('backfillSent');
  }
}
