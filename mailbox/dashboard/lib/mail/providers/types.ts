// dashboard/lib/mail/providers/types.ts
//
// MBOX-356 (P0 of MBOX-355, multi-provider mail) — the MailProvider seam.
// DR-55: every mail transport (Gmail today; IMAP/SMTP + Microsoft Graph next)
// implements this ONE interface. The pipeline core (classify/draft/RAG/urgency/
// digest/queue/audit) never imports a provider — it consumes the CanonicalMessage
// a provider emits and dispatches by accounts.provider via providerFor().
//
// Naming discipline (load-bearing): `provider` HERE means the MAIL TRANSPORT
// (gmail | imap | microsoft) — NOT mailbox.oauth_tokens.provider, which is the
// Google OAuth grant key (google_calendar | google_tasks | google_drive) used by
// the ancillary integrations in lib/oauth/google.ts. Do not conflate the two.
//
// Spec: docs/adr-mailprovider-abstraction-v0_1-2026-05-28.md
//       docs/plan-mbox-356-p0-mailprovider-seam-v0_1-2026-05-29.md

// The closed set of mail transports. Canonical SoT lives in lib/types.ts
// (MAIL_PROVIDERS) alongside the other CHECK-mirrored tuples; re-exported here
// so the provider module is a one-stop import for callers.
import { MAIL_PROVIDERS, type MailProviderKind } from '@/lib/types';

export type { MailProviderKind };
export { MAIL_PROVIDERS };

// Minimal account shape the provider layer needs. Intentionally narrower than
// the full mailbox.accounts row (lib/db/schema.ts `Accounts`) so the seam does
// not couple to the codegen surface; the draft-prompt route passes the resolved
// account through (post-MBOX-352 it already resolves account_id at draft time).
export interface MailAccount {
  id: number;
  provider: MailProviderKind;
  // Provider-specific connection params (IMAP host/port/TLS; Graph tenant/scopes).
  // Empty for Gmail. Backed by accounts.provider_config jsonb (migration 037).
  provider_config: Record<string, unknown>;
}

// Canonical, provider-neutral message. EVERYTHING downstream consumes this —
// never a provider's native shape. Field set mirrors the columns the pipeline
// already reads on mailbox.inbox_messages (see inboxMessageInsertBodySchema).
export interface CanonicalMessage {
  // The provider's native id (Gmail msg id / IMAP Message-ID / Graph id). Stored
  // as drafts.provider_message_id; dedup is keyed (account_id, provider_message_id).
  provider_message_id: string;
  // Normalized conversation key — see MailProvider.normalizeThreadId.
  thread_id: string | null;
  from_addr: string;
  to_addr: string;
  subject: string;
  // Best-effort plaintext body.
  body: string;
  in_reply_to: string | null;
  references: string | null;
  // ISO-8601.
  received_at: string;
  direction: 'inbound' | 'outbound';
}

export interface SendRequest {
  thread_id: string | null;
  in_reply_to: string | null;
  to_addr: string;
  subject: string;
  body: string;
}

export interface SendResult {
  // Stable id used to clear drafts.send_attempt_at and write provider_message_id.
  provider_message_id: string;
  thread_id: string | null;
}

// Provider-declared traits the pipeline branches on INSTEAD of hardcoding
// provider names. Ask the capability, not the brand — closed to new providers.
export interface ProviderCapabilities {
  // false → thread_id must be synthesized from headers (IMAP).
  nativeThreading: boolean;
  // false → poll-only (all transports today; Gmail Pub/Sub was KILLED, DR-22).
  push: boolean;
  // Reserved/informational (FR-MP-2, corrected 2026-05-29). NOT dispatched
  // today: quote format is set by the COUNTERPARTY's client, not the operator's
  // provider, so lib/drafting/strip-quoting stays sender-agnostic (try-all,
  // fail-open — already handles Gmail/Outlook/Apple/mobile/`>`). This flag is a
  // future hook to ADD a provider-specific pattern (e.g. a Graph quirk), never
  // to restrict.
  quoteStrategy: 'gmail' | 'outlook' | 'generic';
}

// Result of classifying a transport error as a rate-limit.
export interface RateLimitHint {
  // null = not a rate-limit error (or the hinted deadline is already in the past).
  until: Date | null;
}

// Options for the onboarding sent-history backfill (RAG/threading seed).
export interface BackfillOptions {
  lookbackHours: number;
  maxMessages?: number;
}

export interface MailProvider {
  readonly kind: MailProviderKind;
  readonly capabilities: ProviderCapabilities;

  // Normalize a provider-raw inbound payload → CanonicalMessage. The single
  // place transport shape is allowed to leak; everything else is canonical.
  normalize(raw: unknown): CanonicalMessage;

  // Produce the canonical thread_id: native id passthrough (Gmail/Graph) or a
  // deterministic synthesis from the References/In-Reply-To chain (IMAP).
  normalizeThreadId(msg: CanonicalMessage): string | null;

  // Classify a transport error as a rate-limit and extract the cooldown deadline.
  parseRateLimit(error: unknown): RateLimitHint;

  // --- Transport I/O ---
  // P0 NOTE: for Gmail these remain n8n's job (Gmail Get / Gmail Reply). The
  // GmailProvider implementations below are declared for interface conformance
  // and throw NotImplementedInP0 — moving Gmail I/O into the dashboard is DR-56/
  // P3, gated on the S-MP-4 spike. IMAP (P1) / Graph (P2) implement these for real.
  listNew(
    account: MailAccount,
    cursor: unknown,
  ): Promise<{ messages: CanonicalMessage[]; cursor: unknown }>;
  send(account: MailAccount, req: SendRequest): Promise<SendResult>;
  backfillSent(account: MailAccount, opts: BackfillOptions): AsyncIterable<CanonicalMessage>;
}
