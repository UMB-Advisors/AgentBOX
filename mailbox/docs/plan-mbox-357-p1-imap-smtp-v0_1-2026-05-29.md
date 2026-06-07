# Plan — MBOX-357 (P1): IMAP/SMTP provider

> **Issue:** MBOX-357 (child of epic MBOX-355) · DR-58 (IMAP auth), inherits DR-57
> **Specs:** `addendum-mailbox-multi-provider-mail-v0_1-2026-05-28.md`, `adr-mailprovider-abstraction-v0_1-2026-05-28.md`
> **Builds on:** P0 (MBOX-356, merged PR #184) — the `MailProvider` seam + `accounts.provider`/`provider_config` + `MAIL_PROVIDERS` SoT.
> **Created:** 2026-05-29 · **Status:** DRAFT — for review
> **Gates:** S-MP-2 (threading ≥95% in-thread) and — if dashboard-owned I/O — S-MP-4 (DR-56).

---

## TL;DR

P1 adds the **first non-Gmail transport**: `ImapSmtpProvider`. It's the lowest-reach-per-effort win (one protocol covers cPanel/Fastmail/Zoho/etc.) and deliberately the **hardest normalization case** — IMAP has *no native thread model*, so it forces the seam's threading synthesis to be real. The pure provider logic (normalize / thread-id synthesis / rate-limit / capabilities) is straightforward and fully unit-testable. The **one genuinely hard decision** is *where IMAP I/O runs* — n8n (new `MailBOX-Imap` workflow, no new dashboard deps) vs dashboard-owned poll loop (DR-56 direction, but adds `imapflow`+`nodemailer`, cutting against the appliance's dependency-light constraint). **Resolve that first (spike).** P1 also lands the P0-deferred schema (`mail_cooldowns`, `provider_message_id`) because IMAP is their first consumer.

---

## What P0 already gives us (don't rebuild)

- `dashboard/lib/mail/providers/types.ts` — `MailProvider`, `CanonicalMessage`, `ProviderCapabilities`, `RateLimitHint`, `MailAccount`.
- `gmail.ts` (reference impl) + `index.ts` `providerFor()` factory (the `imap` arm currently throws "not implemented (P1)").
- `accounts.provider` (`gmail|imap|microsoft`) + `accounts.provider_config jsonb`; `MAIL_PROVIDERS` SoT tuple + schema invariant.

P1 = fill in the `imap` arm + the I/O path + the inherited schema + onboarding.

---

## The crux decision (resolve before coding): where does IMAP I/O run?

DR-56 is **Candidate**. P0 left Gmail I/O in n8n. For IMAP there's a real tension:

| | **Option A — n8n `MailBOX-Imap` workflow** | **Option B — dashboard-owned poll loop** |
|---|---|---|
| Ingress | n8n `IMAP Email Read` (`n8n-nodes-base.emailReadImap`) → POST provider-raw to `/api/internal/inbox-messages` (gains a `provider` discriminator) → `ImapSmtpProvider.normalize` server-side | `setInterval` in `instrumentation.ts` (like the existing sweepers) using `imapflow` → normalize → existing insert path |
| Egress | n8n `Send Email` (SMTP) node, selected by `accounts.provider` | `nodemailer` (or raw SMTP) in `transitions.ts` send path |
| New dashboard deps | **none** (n8n bundles IMAP/SMTP) | **`imapflow` + `nodemailer`** — cuts against the dependency-light constraint (CLAUDE.md; `lib/oauth/google.ts` deliberately avoided `googleapis`) |
| Testability | normalization is in TS (testable); the poll/connection lives in n8n (not) | fully in-process, fully testable; matches STAQPRO-187's "rip out n8n" direction |
| Workflow sprawl | +1 parent workflow per provider (the thing DR-56 wants to avoid long-term) | none |

**Recommendation:** run a short spike (**S-MP-4, IMAP-scoped**) — stand up n8n's `IMAP Email Read` against a test mailbox and confirm it polls + hands off reliably. **Lean Option A for P1** (no new deps, ships faster, keeps the dependency-light constraint), and revisit Option B as the deliberate DR-56 cutover once ≥2 non-Gmail providers exist and workflow sprawl is the real cost. Either way, **`ImapSmtpProvider`'s pure methods are identical** — only the caller of `listNew`/`send` differs — so this decision does not block the provider class itself.

---

## Task breakdown

### T1 — `ImapSmtpProvider` pure logic (no I/O, fully testable)
`dashboard/lib/mail/providers/imap.ts implements MailProvider`:
- `capabilities = { nativeThreading: false, push: false, quoteStrategy: 'generic' }`.
- `normalize(raw)` — map IMAP envelope/headers → `CanonicalMessage` (`Message-ID` → `provider_message_id`; parse `From`/`To`/`Subject`/`Date`/`In-Reply-To`/`References`).
- `normalizeThreadId(msg)` — **the S-MP-2 core** (see below).
- `parseRateLimit(error)` — IMAP/SMTP connection/login throttle detection (host-specific; conservative default cooldown). Different shape from Gmail's `Retry-After`.
- Unit tests mirroring `gmail.test.ts` (normalize fields, threadId synthesis cases, capability shape).
- Flip the `index.ts` factory `imap` arm to return `new ImapSmtpProvider()`.

### T2 — Threading synthesis (FR-MP-1) — the hardest part, gates on S-MP-2
IMAP has no thread id. Synthesize a stable `thread_id`:
1. If `References` present → `thread_id = hash(first Message-ID in the References chain)` (the conversation root). Deterministic, stable across messages in the thread.
2. Else if `In-Reply-To` present → `hash(In-Reply-To)`.
3. Else → the message is a root: `thread_id = hash(own Message-ID)`.
4. Last-resort fallback (no usable headers): normalized-subject + participant-set hash, **flagged low-confidence**.
- `thread-history.ts` already keys on `thread_id` → works unchanged once IMAP populates it.
- **S-MP-2 gate:** ≥95% of a test-corpus's replies land in-thread. Kill criterion: if header chains are too sparse, ship IMAP "flat" (no thread context) behind a flag + surface the degraded mode.

### T3 — Inherited schema (now consumed → land it here)
Migration `038`:
- `mail_cooldowns(account_id, provider, until, set_at)` — replace the single-row global `system_state.gmail_rate_limit_until` read with a per-`(account_id, provider)` lookup. **Migrate the live circuit-breaker consumers** (`queries-system-state.ts`, `gmail-ratelimit-sweeper.ts`, `/api/{internal,system}/gmail-cooldown`, `transitions.ts` gate) to the keyed table; keep a compatibility shim for the Gmail row during cutover. This is the high-blast-radius change P0 deliberately deferred — it gets real test coverage here.
- `drafts.provider_message_id` — add + backfill from `sent_gmail_message_id`; the IMAP send path writes it. (Keep `sent_gmail_message_id` as n8n's Gmail write target until P3.)
- Mirror in `test/fixtures/schema.sql` + regen `lib/db/schema.ts` + schema invariants.

### T4 — Quote-strategy dispatch (the P0-deferred T4, now real)
`strip-quoting.ts` gains a `strategy: 'gmail' | 'outlook' | 'generic'` param; `draft-prompt`/`draft-redraft` resolve `providerFor(account).capabilities.quoteStrategy`. Implement the `generic` heuristic for IMAP; `gmail` unchanged.

### T5 — IMAP ingress/egress (per the crux decision)
- **Option A:** `MailBOX-Imap` n8n workflow (`IMAP Email Read` → `/api/internal/inbox-messages` with `provider:'imap'`); `Send Email` SMTP node in the send path keyed by provider. `/api/internal/inbox-messages` gains a `provider` field + dispatches `providerFor(provider).normalize`.
- **Option B:** `imapflow` poll loop in `instrumentation.ts` + `nodemailer` send in `transitions.ts`.

### T6 — Onboarding (FR-MP-6)
Provider picker in the wizard (MBOX-216); IMAP form (host/port/TLS/username/app-password → `accounts.provider_config` + encrypted secret) + a **test-connection probe** before save. Per-account credential storage (the `oauth_tokens` table is OAuth-only; IMAP app-passwords need an encrypted store — reuse the AES-256-GCM pattern from `lib/oauth/google.ts`).

---

## Risks

| Risk | Mitigation |
|---|---|
| **Threading synthesis unreliable** (S-MP-2 kill) | Test-corpus measurement first; flat-mode fallback flagged. |
| **`mail_cooldowns` cutover regresses the live Gmail circuit breaker** | Compatibility shim + full test coverage; this is why P0 deferred it — do it with care + tests, not blind. |
| **Dependency-light constraint** (Option B adds imapflow/nodemailer) | Lean Option A (n8n) for P1; treat Option B as the deliberate DR-56 cutover later. |
| **IMAP basic-auth deprecation** (Gmail-IMAP/Yahoo dropped it) | DR-58: app-password for v1 (cPanel/Fastmail/Zoho still support it); XOAUTH2 only if a target host needs it (NC-33). |
| **SMTP deliverability** (SPF/DKIM) | Send via the customer's own SMTP, domain-aligned (NC-37) — no relay in v1. |

---

## Sequencing & DoD

1. Resolve the crux (S-MP-4 IMAP spike) → pick Option A/B.
2. T1 (provider pure logic) + T2 (threading) — independent of the I/O decision; do first.
3. T3 (schema) → T4 (quote dispatch) → T5 (I/O) → T6 (onboarding).

**DoD (S-MP-1 + S-MP-2):** an IMAP account completes inbound→classify→draft→approve→send on the M1 test rig (SM-91); replies land in-thread ≥95% (SM-93); Gmail path unaffected (existing eval/smoke green); `tsc` + full vitest + `db:codegen:verify` green.
