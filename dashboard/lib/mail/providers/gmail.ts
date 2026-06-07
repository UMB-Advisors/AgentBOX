// dashboard/lib/mail/providers/gmail.ts
//
// MBOX-356 (P0) — GmailProvider: the dashboard-side Gmail specifics behind the
// MailProvider seam (DR-55). Behavior-preserving extraction of logic that
// already exists today; no new behavior.
//
// SCOPE BOUNDARY: Gmail TRANSPORT (fetch/send) stays in n8n (Gmail Get / Gmail
// Reply) for P0 — listNew/send/backfillSent throw NotImplementedInP0. Moving
// I/O into the dashboard is DR-56/P3, gated on the S-MP-4 spike. What lives here
// in P0 is the provider-neutral-facing logic: normalize, thread-id provenance,
// and rate-limit parsing.
//
// parseRateLimit is the provider-owned home for "how Gmail expresses a 429."
// The live lib/jobs/gmail-ratelimit-sweeper.ts is deliberately NOT rewired in P0
// — it reads n8n's execution_data (SQL-side extraction) and belongs to the
// n8n-coupled world DR-56/P3 replaces. parseRateLimit is consumed by the
// dashboard-owned IMAP/Graph poll loops (P1/P2), where a JS error object exists.

import { fetchSentViaGmail } from '@/lib/mail/gmail-fetch';
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

// Default Sent cap when the orchestrator passes no maxMessages — matches the
// IMAP provider's DEFAULT_BACKFILL_MAX_MESSAGES and the 90-day lookback default
// in the voice-backfill orchestrators.
const DEFAULT_BACKFILL_MAX_MESSAGES = 500;

export class NotImplementedInP0 extends Error {
  constructor(method: string) {
    super(
      `GmailProvider.${method}() is owned by n8n in P0 (Gmail Get / Gmail Reply). ` +
        `Dashboard-owned Gmail I/O is DR-56/P3, gated on S-MP-4.`,
    );
    this.name = 'NotImplementedInP0';
  }
}

// Matches the "Retry after <ISO>" hint Google embeds verbatim in its 429 body,
// the same substring lib/jobs/gmail-ratelimit-sweeper.ts extracts from n8n's
// serialized execution error. Tolerant of surrounding text.
const RETRY_AFTER_RE = /Retry after\s+([0-9T:.Z+-]+)/i;

function asText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export class GmailProvider implements MailProvider {
  readonly kind = 'gmail' as const;

  readonly capabilities: ProviderCapabilities = {
    nativeThreading: true, // Gmail thread id is authoritative.
    push: false, // Pub/Sub KILLED (DR-22) — we poll via the 5-min Schedule.
    quoteStrategy: 'gmail',
  };

  // Map a Gmail-shaped inbound payload (the inboxMessageInsertBodySchema field
  // set) → CanonicalMessage. Defensive: every field tolerates absence, matching
  // how the inbox-messages route falls back to '' / null today.
  normalize(raw: unknown): CanonicalMessage {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      provider_message_id: str(r.message_id ?? r.provider_message_id),
      thread_id: strOrNull(r.thread_id),
      from_addr: str(r.from_addr ?? r.from),
      to_addr: str(r.to_addr ?? r.to),
      subject: str(r.subject),
      body: str(r.body ?? r.snippet),
      in_reply_to: strOrNull(r.in_reply_to),
      references: strOrNull(r.references),
      received_at: str(r.received_at),
      direction: r.direction === 'outbound' ? 'outbound' : 'inbound',
    };
  }

  // Gmail provides an authoritative thread id; canonical thread_id is a passthrough.
  normalizeThreadId(msg: CanonicalMessage): string | null {
    return msg.thread_id;
  }

  // Extract Google's 429 "Retry after <ISO>" hint. Returns until=null when there
  // is no hint or the hinted deadline is already in the past (mirrors the
  // sweeper: a past timestamp is a no-op since the cooldown's only job is to
  // prevent an IMMEDIATE re-fire).
  parseRateLimit(error: unknown): RateLimitHint {
    const match = RETRY_AFTER_RE.exec(asText(error));
    if (!match) return { until: null };
    const parsed = new Date(match[1]);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      return { until: null };
    }
    return { until: parsed };
  }

  // --- Transport I/O ---
  // listNew / send remain n8n's job (Gmail Get / Gmail Reply) — the live inbound
  // poll + reply still flow through the workflows (file header / DR-56). These
  // stay not-implemented guards.
  listNew(
    _account: MailAccount,
    _cursor: unknown,
  ): Promise<{ messages: CanonicalMessage[]; cursor: unknown }> {
    throw new NotImplementedInP0('listNew');
  }

  send(_account: MailAccount, _req: SendRequest): Promise<SendResult> {
    throw new NotImplementedInP0('send');
  }

  // backfillSent IS implemented (MBOX-399 / MBOX-162 V6 P3 — the first slice of
  // dashboard-owned Gmail I/O, DR-56). Transport-pure: the per-account
  // gmail.readonly access token is injected by the orchestrator at call time as
  // account.provider_config.access_token (this layer never touches the DB or
  // getAccessToken). Delegates the REST mechanics to fetchSentViaGmail and the
  // pure mapping to gmail-parse. An AsyncGenerator satisfies AsyncIterable.
  async *backfillSent(
    account: MailAccount,
    opts: BackfillOptions,
  ): AsyncGenerator<CanonicalMessage> {
    const accessToken = str(account.provider_config.access_token);
    if (!accessToken) {
      // The orchestrator guarantees this — a missing token here is a wiring bug,
      // not an operator-facing not-connected (that's resolved before we get here).
      throw new Error('GmailProvider.backfillSent: no access_token in provider_config');
    }
    yield* fetchSentViaGmail(accessToken, {
      lookbackHours: opts.lookbackHours,
      maxMessages: opts.maxMessages ?? DEFAULT_BACKFILL_MAX_MESSAGES,
    });
  }
}
