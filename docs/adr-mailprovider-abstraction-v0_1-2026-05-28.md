# ADR — DR-55: The `MailProvider` Abstraction

> **Decision record:** DR-55 (continues the appliance-spec shared namespace)
> **Status:** Accepted (architecture); implementation gated phase-by-phase per spike (§ Validation)
> **Date:** 2026-05-28
> **Context spec:** `addendum-mailbox-multi-provider-mail-v0_1-2026-05-28.md`
> **Supersedes / extends:** nothing. Builds on migration 033 (`account_id`, `mailbox.accounts`, `mailbox.oauth_tokens`; MBOX-348) and the n8n Boundary Contract (STAQPRO-186).
> **Related:** DR-56 (n8n boundary, Candidate), DR-57 (provider dimension, Accepted), DR-58 (IMAP auth, Candidate), STAQPRO-187 (narrow-the-n8n-boundary spike), DR-22 (Pub/Sub KILLED — we poll).

---

## TL;DR

Introduce a single TypeScript interface, `MailProvider`, in `dashboard/lib/mail/providers/`. Every mail transport (Gmail, IMAP/SMTP, Microsoft Graph) implements it. The pipeline core never imports a provider — it consumes the **canonical message** the provider emits and dispatches by `accounts.provider`. We adopt this over (a) forking the n8n workflows per provider and (b) scattering `if (provider === …)` branches through the existing routes, because the abstraction is the only option that keeps the four Gmail-coupled edges testable and makes provider #4 a class, not a project.

---

## Context

MailBOX is Gmail-only. The pipeline core (classify/draft/RAG/urgency/digest/queue/audit) is already provider-agnostic — it reads `mailbox.inbox_messages` / `mailbox.drafts`. The coupling is at four edges (ingress, egress, rate-limit circuit breaker, threading/quoting; enumerated in the addendum §2). We are committing to **IMAP/SMTP** and **Microsoft 365**.

The structural question this ADR answers: **where does provider-specific logic live, and what contract isolates it from the pipeline?**

Three forces constrain the answer:
1. **n8n owns I/O today.** Gmail read/send are n8n nodes; the rate-limit sweeper reads provider error shapes out of n8n's `execution_data`. Any abstraction must say what stays in n8n and what moves.
2. **`account_id` just became first-class** (migration 033). Provider is a *second* dimension on the same `mailbox.accounts` substrate — not a new substrate.
3. **The boundary is already documented as narrow** (STAQPRO-186): "2 webhooks one direction, 7 routes the other, 2 credentials… small enough to reimplement in a single sprint" (STAQPRO-187). Multi-provider is what makes spending that sprint worthwhile.

---

## Decision

### The interface

A provider is a class implementing `MailProvider`, resolved by a factory keyed on `accounts.provider`:

```ts
// dashboard/lib/mail/providers/types.ts

/** Canonical, provider-neutral message. Everything downstream consumes THIS,
 *  never a provider's native shape. Mirrors the columns the pipeline already
 *  reads on mailbox.inbox_messages. */
export interface CanonicalMessage {
  provider_message_id: string;          // provider's native id (Gmail msg id / IMAP Message-ID / Graph id)
  thread_id: string | null;             // normalized — see normalizeThreadId()
  from_addr: string;
  to_addr: string;
  subject: string;
  body: string;                         // best-effort plaintext
  in_reply_to: string | null;
  references: string | null;
  received_at: string;                  // ISO-8601
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
  provider_message_id: string;          // stable id used to clear send_attempt_at + write back
  thread_id: string | null;
}

/** Provider-declared traits the pipeline branches on instead of hardcoding
 *  provider names. Keeps callers honest: ask the capability, not the brand. */
export interface ProviderCapabilities {
  nativeThreading: boolean;             // false → thread_id is synthesized (IMAP)
  push: boolean;                        // false → poll-only (all today; DR-22)
  quoteStrategy: 'gmail' | 'outlook' | 'generic';
}

export interface RateLimitHint {
  until: Date | null;                   // null = not a rate-limit error
}

export interface MailProvider {
  readonly capabilities: ProviderCapabilities;

  /** Poll for new inbound since the account's cursor. */
  listNew(account: Account, cursor: ProviderCursor): Promise<{ messages: CanonicalMessage[]; cursor: ProviderCursor }>;

  /** Pull prior sent history for the RAG/threading backfill (onboarding). */
  backfillSent(account: Account, opts: BackfillOpts): AsyncIterable<CanonicalMessage>;

  /** Send a reply / new message. Returns the stable id for write-back. */
  send(account: Account, req: SendRequest): Promise<SendResult>;

  /** Normalize provider raw → CanonicalMessage. The one place transport
   *  shape leaks; everything else is canonical. */
  normalize(raw: unknown): CanonicalMessage;

  /** Produce the canonical thread_id (native id, or synthesized from headers). */
  normalizeThreadId(msg: CanonicalMessage): string | null;

  /** Classify an error as a rate-limit and extract the cooldown deadline. */
  parseRateLimit(error: unknown): RateLimitHint;
}
```

### What stays where

- **Pipeline core** (classify, draft, RAG, urgency, digest, queue, audit): **unchanged.** Consumes `CanonicalMessage`; dispatches by `accounts.provider`. Never imports a provider class.
- **Provider classes**: `GmailProvider`, `ImapSmtpProvider`, `MicrosoftGraphProvider` under `dashboard/lib/mail/providers/`. The *only* place transport specifics live.
- **The four edges** map onto interface methods: ingress → `listNew`/`backfillSent`; egress → `send`; rate-limit → `parseRateLimit` (+ per-`(account, provider)` cooldown, DR-57); threading → `normalizeThreadId` + `capabilities.quoteStrategy`.
- **n8n**: in P0–P2, n8n still drives the schedule and (Option A) calls a provider-aware internal route that does normalization in TS. DR-56 (gated) decides whether n8n's I/O nodes are retired in P3.

### Why dispatch on a capability, not a brand

`if (provider === 'gmail')` rots — every new provider edits every call site. `if (provider.capabilities.nativeThreading)` asks the question that actually matters and is closed to new providers. This is the discriminated-union / capability-flag discipline from the repo's TS conventions, applied at the architecture seam.

---

## Alternatives considered

| Option | What | Why rejected (or deferred) |
|--------|------|----------------------------|
| **A. Per-provider n8n workflows** | `MailBOX-Imap`, `MailBOX-Graph` as parallel workflow JSONs selected by `accounts.provider`; normalization in Set nodes | 3× the workflow-JSON to maintain; normalization in untestable n8n expressions; the rate-limit sweeper would parse 3 error shapes out of `execution_data`. **Kept as the DR-56 fallback** if dashboard-owned I/O fails its spike — but not the primary path. |
| **B. Inline `if (provider===…)` in existing routes** | No interface; branch per provider in `inbox-messages`, `draft-prompt`, `transitions`, the sweeper | Spreads transport knowledge across the whole codebase; every provider touches every file; un-unit-testable in isolation. The thing the abstraction exists to prevent. |
| **C. `MailProvider` abstraction (chosen)** | One interface, N classes, capability dispatch | Highest up-front cost (P0 extraction), lowest marginal cost per future provider. The P0 spike (S-MP-1) de-risks it: extract Gmail, prove the eval suite stays green, *then* add providers. |

---

## Consequences

**Positive**
- Provider #4 is a class implementing one interface, not a fork.
- The four edges become unit-testable against a fake `MailProvider` — no n8n, no live Gmail, in CI.
- Forces resolution of STAQPRO-187: the interface *is* the n8n-replacement spec.
- Composes cleanly with multi-account — `(account_id, provider)` is the natural key throughout (DR-57).

**Negative / costs**
- P0 is pure refactor with no user-visible feature — must be justified by the de-risking it buys (and gated by S-MP-1 so it can't silently regress Gmail).
- IMAP forces the hardest case first (no native threading, FR-MP-1) — but that's deliberate: if the seam survives IMAP, Graph is trivial.
- A schema migration renames Gmail-specific columns (`gmail_message_id` → `provider_message_id`, cooldown table); needs the migration-007 comment + reversal discipline and a transition view.

**Neutral**
- No change to the privacy model — cloud-gating is route-based, not transport-based (FR-MP-7).
- The idempotency lock (migration 025) is already provider-neutral and stays untouched (FR-MP-4).

---

## Validation

Implementation proceeds only as each spike passes (addendum §7):
- **S-MP-1** gates P0: extraction must leave Gmail eval baselines + pipeline smoke green.
- **S-MP-2** gates IMAP threading viability (≥95% in-thread).
- **S-MP-3** gates the Microsoft consent model.
- **S-MP-4** gates DR-56 (whether to retire n8n I/O).

The kill criterion for the ADR itself: if S-MP-1 shows the extraction can't preserve Gmail behavior, the seam shape is wrong — redesign the interface before any new provider lands.
