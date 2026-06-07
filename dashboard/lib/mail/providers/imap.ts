// dashboard/lib/mail/providers/imap.ts
//
// MBOX-357 (P1) — ImapSmtpProvider: the first non-Gmail transport behind the
// MailProvider seam (DR-55). This file is the DECISION-INDEPENDENT core
// (T1 + T2): normalize, thread-id synthesis, rate-limit parsing, capabilities —
// all pure and unit-tested. It does NOT decide where IMAP I/O runs (n8n
// MailBOX-Imap workflow vs dashboard-owned poll loop, the DR-56 crux) — the
// transport methods throw NotImplementedYet until that's resolved (T5).
//
// The hard part is threading (FR-MP-1 / gate S-MP-2): IMAP has no native thread
// id, so we synthesize a stable one from the RFC5322 References / In-Reply-To
// header chain. See normalizeThreadId.

import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
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

export class NotImplementedYet extends Error {
  constructor(method: string) {
    super(
      `ImapSmtpProvider.${method}() — transport I/O lands in P1 T5, pending the ` +
        `DR-56 decision (n8n MailBOX-Imap workflow vs dashboard-owned poll loop).`,
    );
    this.name = 'NotImplementedYet';
  }
}

// Default cooldown when a throttle signal is detected but the server gives no
// machine-readable retry hint (IMAP/SMTP rarely do). Conservative — the
// cooldown's only job is to stop an immediate re-fire. Overridable per host
// later via provider_config.
const DEFAULT_THROTTLE_COOLDOWN_MS = 15 * 60 * 1000;

// IMAP/SMTP throttle / temporary-failure signals. SMTP 4xx (421 service not
// available, 450/451 mailbox busy / local error) + common textual hints.
const THROTTLE_RE =
  /\b(421|45[01])\b|too many|throttl|rate limit|try again later|\[LIMIT\]|\[THROTTLED\]/i;

// Default lookback for backfillSent when the orchestrator passes nothing — kept
// in lib/mail/imap-voice-backfill.ts (90 days); this is a transport-level guard
// only. Maximum messages pulled per Sent backfill (tail of the uid list = the
// most recent N) when opts.maxMessages is unset.
const DEFAULT_BACKFILL_MAX_MESSAGES = 500;

// Case-insensitive name fallbacks when the server doesn't flag the Sent mailbox
// with the RFC 6154 \Sent special-use attribute. Covers Gmail-IMAP, Outlook/
// Exchange ("Sent Items"), and the bare RFC convention.
const SENT_MAILBOX_NAMES = [
  'Sent',
  'Sent Mail',
  '[Gmail]/Sent Mail',
  'Sent Items',
  'Sent Messages',
];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Strip RFC5322 angle brackets + surrounding whitespace from a Message-ID.
// '<abc@host>' → 'abc@host'. Tolerant of already-bare ids and empty input.
function bareMsgId(v: unknown): string {
  return str(v).trim().replace(/^<|>$/g, '').trim();
}

function strOrNullId(v: unknown): string | null {
  const b = bareMsgId(v);
  return b.length > 0 ? b : null;
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

// Deterministic, uniform-length thread key from a root identifier. Prefixed so a
// synthesized IMAP thread_id is visibly distinguishable from a native Gmail one
// when debugging mailbox.drafts.thread_id.
function synthThreadId(root: string): string {
  return `imap-${createHash('sha256').update(root).digest('hex').slice(0, 32)}`;
}

// First (oldest / root) Message-ID in a References header. References is a
// space-separated list ordered oldest→newest, so the FIRST entry is the
// conversation root — the stable key every message in the thread shares.
function referencesRoot(references: unknown): string | null {
  const raw = str(references).trim();
  if (!raw) return null;
  const first = raw.split(/\s+/).find((t) => t.trim().length > 0);
  return first ? bareMsgId(first) : null;
}

// Parse a raw RFC822 message (the IMAP `source` of a Sent item) into a
// CanonicalMessage. Pure + independently unit-testable from a fixture .eml —
// no IMAP connection required. `direction` is always 'outbound' (this only
// ever runs over the Sent mailbox). thread_id is synthesized via the same
// header-chain logic the inbound path uses (normalizeThreadId).
export async function parseSentRfc822(source: Buffer | string): Promise<CanonicalMessage> {
  const parsed = await simpleParser(source);

  const fromAddr = parsed.from?.value?.[0]?.address ?? '';
  // `to` may be an AddressObject or AddressObject[] depending on header count.
  const to = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
  const toAddr = to?.value?.[0]?.address ?? to?.text ?? '';
  // Prefer plaintext; fall back to a crude tag-strip of the HTML part.
  const body = parsed.text ?? (parsed.html ? parsed.html.replace(/<[^>]*>/g, ' ') : '');
  // mailparser normalizes `references` to string | string[] | undefined.
  const references = Array.isArray(parsed.references)
    ? parsed.references.join(' ')
    : (parsed.references ?? null);

  const msg: CanonicalMessage = {
    provider_message_id: bareMsgId(parsed.messageId),
    thread_id: null, // set below once the chain fields are populated
    from_addr: fromAddr.toLowerCase(),
    to_addr: toAddr.toLowerCase(),
    subject: parsed.subject ?? '',
    body,
    in_reply_to: strOrNullId(parsed.inReplyTo),
    references: references && references.trim().length > 0 ? references : null,
    received_at: parsed.date?.toISOString() ?? new Date().toISOString(),
    direction: 'outbound',
  };
  msg.thread_id = new ImapSmtpProvider().normalizeThreadId(msg);
  return msg;
}

export class ImapSmtpProvider implements MailProvider {
  readonly kind = 'imap' as const;

  readonly capabilities: ProviderCapabilities = {
    nativeThreading: false, // synthesized from headers — see normalizeThreadId.
    push: false, // poll-only (IMAP IDLE is flaky across hosts; not used in v1).
    quoteStrategy: 'generic',
  };

  // Map an IMAP-shaped inbound payload → CanonicalMessage. Tolerant of the key
  // variants emitted by n8n's emailReadImap node and by imapflow envelopes.
  normalize(raw: unknown): CanonicalMessage {
    const r = (raw ?? {}) as Record<string, unknown>;
    const msg: CanonicalMessage = {
      provider_message_id: bareMsgId(r.message_id ?? r.messageId ?? r['message-id']),
      thread_id: null, // set below via normalizeThreadId once fields are populated
      from_addr: str(r.from_addr ?? r.from),
      to_addr: str(r.to_addr ?? r.to),
      subject: str(r.subject),
      body: str(r.body ?? r.text ?? r.snippet),
      in_reply_to: strOrNullId(r.in_reply_to ?? r.inReplyTo ?? r['in-reply-to']),
      references: ((): string | null => {
        const v = str(r.references).trim();
        return v.length > 0 ? v : null;
      })(),
      received_at: str(r.received_at ?? r.date),
      direction: r.direction === 'outbound' ? 'outbound' : 'inbound',
    };
    msg.thread_id = this.normalizeThreadId(msg);
    return msg;
  }

  // Synthesize a stable thread_id from the header chain (FR-MP-1):
  //   1. References root (oldest id in the chain) — the conversation anchor.
  //   2. else In-Reply-To — direct parent (single-reply threads with no References).
  //   3. else the message's own id — it IS a thread root (new conversation).
  //   4. else null — no usable identifier (degraded; flat handling upstream).
  // Every message in a thread resolves to the same root → same thread_id.
  // (A subject+participants fallback is intentionally NOT done — it risks
  //  false-merging unrelated mail; flagged low-confidence in the plan, deferred.)
  normalizeThreadId(msg: CanonicalMessage): string | null {
    const root =
      referencesRoot(msg.references) ?? msg.in_reply_to ?? (msg.provider_message_id || null);
    return root ? synthThreadId(root) : null;
  }

  // IMAP/SMTP have no standard machine-readable retry hint. Detect a throttle /
  // temporary-failure signal and return a conservative future cooldown; else
  // null. (Contrast GmailProvider, which parses Google's explicit "Retry after".)
  parseRateLimit(error: unknown): RateLimitHint {
    if (!THROTTLE_RE.test(asText(error))) return { until: null };
    return { until: new Date(Date.now() + DEFAULT_THROTTLE_COOLDOWN_MS) };
  }

  // --- Transport I/O: P1 T5, pending the DR-56 decision (see file header). ---
  listNew(
    _account: MailAccount,
    _cursor: unknown,
  ): Promise<{ messages: CanonicalMessage[]; cursor: unknown }> {
    throw new NotImplementedYet('listNew');
  }

  send(_account: MailAccount, _req: SendRequest): Promise<SendResult> {
    throw new NotImplementedYet('send');
  }

  // Stream the account's Sent mailbox as CanonicalMessages over the lookback
  // window (MBOX-373 / MBOX-162 V6 P2 — historical-voice backfill). Transport-
  // pure: the decrypted app-password is injected by the orchestrator at call
  // time as account.provider_config.password (this layer never touches the DB
  // or decryptToken). An AsyncGenerator satisfies the AsyncIterable contract.
  async *backfillSent(
    account: MailAccount,
    opts: BackfillOptions,
  ): AsyncGenerator<CanonicalMessage> {
    const cfg = account.provider_config;
    const host = str(cfg.imap_host);
    const port = typeof cfg.imap_port === 'number' ? cfg.imap_port : 993;
    const user = str(cfg.username);
    const pass = str(cfg.password);

    const client = new ImapFlow({
      host,
      port,
      secure: true,
      auth: { user, pass },
      logger: false,
    });
    await client.connect();

    try {
      // Locate the Sent mailbox: prefer the RFC 6154 \Sent special-use flag,
      // else a case-insensitive name match against the known conventions.
      // No early `return` inside this try (it's an async generator) — nest the
      // happy path under guards so client.logout()/lock.release() always run on
      // every exit, including the no-Sent-mailbox / empty-window cases.
      const boxes = await client.list();
      const wanted = new Set(SENT_MAILBOX_NAMES.map((n) => n.toLowerCase()));
      const sent =
        boxes.find((b) => b.specialUse === '\\Sent') ??
        boxes.find((b) => wanted.has(b.path.toLowerCase())) ??
        boxes.find((b) => wanted.has(b.name?.toLowerCase() ?? ''));

      if (sent) {
        const lock = await client.getMailboxLock(sent.path);
        try {
          const since = new Date(Date.now() - opts.lookbackHours * 3600_000);
          const found = await client.search({ since }, { uid: true });
          const uids = found || [];

          if (uids.length > 0) {
            // Tail = the most recent N (uids come back ascending).
            const cap = opts.maxMessages ?? DEFAULT_BACKFILL_MAX_MESSAGES;
            const slice = uids.length > cap ? uids.slice(-cap) : uids;

            for await (const m of client.fetch(slice, { uid: true, source: true }, { uid: true })) {
              if (!m.source) continue;
              try {
                yield await parseSentRfc822(m.source);
              } catch (err) {
                // One malformed MIME message must never abort the whole backfill.
                // Log the uid only — never body content (privacy).
                console.error(`parseSentRfc822 skipped uid=${m.uid}:`, asText(err));
              }
            }
          }
        } finally {
          lock.release();
        }
      }
    } finally {
      await client.logout();
    }
  }
}
