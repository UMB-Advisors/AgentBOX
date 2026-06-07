# Plan — MBOX-356 (P0): MailProvider abstraction seam + provider schema dimension

> **Issue:** MBOX-356 (child of epic MBOX-355) · DR-55, DR-57
> **Specs:** `addendum-mailbox-multi-provider-mail-v0_1-2026-05-28.md`, `adr-mailprovider-abstraction-v0_1-2026-05-28.md`
> **Branch base:** current `master` (includes MBOX-162 V1 migration 033 + V2 migration 036 / PR #181)
> **Created:** 2026-05-29 · **Status:** DRAFT — ready to execute once the spec is reviewed
> **Gate:** S-MP-1 — Gmail eval baselines + pipeline smoke stay green. No behavior change.

---

## TL;DR

P0 is a **pure de-risking refactor — no new provider, no user-visible feature.** It (1) introduces the `MailProvider` interface and extracts today's *dashboard-side* Gmail logic into a `GmailProvider`, and (2) makes `provider` a first-class column on `mailbox.accounts`, keyed alongside the `account_id` dimension that V1/V2 just landed. **It deliberately does NOT touch Gmail's transport** — `Gmail Get` / `Gmail Reply` stay in n8n. Moving I/O into the dashboard is DR-56/P3, gated on a separate spike. The win is: after P0, adding `ImapSmtpProvider` (P1) is a new class implementing one interface, and the four Gmail-coupled edges are unit-testable without n8n or a live mailbox.

---

## Scope adjustment (2026-05-29, post NC-35 = "compose")

As-built P0 is **tighter than the original task list**, on two engineering grounds (no dead schema; keep P0 off the live circuit-breaker tables):

| Original task | As-built | Reason |
|---------------|----------|--------|
| T2 — rewire the rate-limit sweeper to call `parseRateLimit` | **Deferred.** Sweeper left as-is. | It's an n8n-`execution_data` reader (SQL-side extraction) — part of the n8n-coupled world P3 replaces. `GmailProvider.parseRateLimit` exists + is unit-tested, ready for the dashboard-owned IMAP/Graph poll loops (P1/P2) where JS errors exist. |
| T3 — migration: `accounts.provider` + cooldown reshape + `provider_message_id` | **Trimmed to `accounts.provider` + `provider_config`** (migration 037). Cooldown reshape + `provider_message_id` → **P1 (MBOX-357)**. | The latter two have no consumer until a 2nd provider exists → would be dead schema, and would needlessly touch the live `system_state` cooldown + the n8n-written `sent_gmail_message_id`. |
| T4 — capability-based quote-strategy dispatch | **Deferred to P1.** | The `outlook`/`generic` strategies don't exist yet; wiring a no-op strategy param now is churn. |

Net P0 = **the seam (T1) + the `accounts.provider` discriminator + the `MAIL_PROVIDERS` SoT tuple + invariant (T5) + docs (T6)** — zero live-behavior change, zero dead schema. This fully enables P1 (IMAP attaches as a new `MailProvider` class).

---

## Scope boundary (read this first)

**In scope (P0):**
- The `MailProvider` TypeScript interface + canonical message type.
- `GmailProvider` wrapping the dashboard-side Gmail specifics that exist *today*: message normalization, thread-id provenance, rate-limit parsing, capability flags.
- `accounts.provider` + `provider_config` columns; per-`(account_id, provider)` cooldown; provider-neutral sent-message-id.
- Capability-based dispatch wired at the draft-prompt account-resolution point (the V2 seam).

**Explicitly OUT of scope (later phases):**
- Reimplementing Gmail fetch/send in the dashboard — **n8n keeps `Gmail Get` / `Gmail Reply`** (DR-56/P3, gated on S-MP-4).
- Any new provider (`ImapSmtpProvider` = P1/MBOX-357, `MicrosoftGraphProvider` = P2/MBOX-358).
- Moving Gmail mail-OAuth out of n8n's credential store. (Note: `mailbox.oauth_tokens` is **only** the ancillary Google grants — calendar/tasks/drive — see `lib/oauth/google.ts:OAUTH_PROVIDERS`. Gmail mail auth is the n8n `gmailOAuth2` credential. Don't conflate them.)

---

## Naming reconciliation (load-bearing)

There are now **two distinct `provider` concepts** — the plan keeps them separate and never overloads one for the other:

| Column | Meaning | Values | Owner |
|--------|---------|--------|-------|
| `mailbox.accounts.provider` *(NEW, P0)* | **Mail transport** for the inbox | `gmail` \| `imap` \| `microsoft` | this plan |
| `mailbox.oauth_tokens.provider` *(exists, V1)* | **Google OAuth grant key** for ancillary integrations | `google_calendar` \| `google_tasks` \| `google_drive` | `lib/oauth/google.ts` |

The `MailProvider` factory keys on `accounts.provider`. It never reads `oauth_tokens.provider`.

---

## NC-35 working assumption

This plan assumes **multi-provider composes with multi-account** (NC-35 → "compose"), because V2 (MBOX-352) already made `account_id` a first-class *scoping* key — a provider that didn't compose with account would contradict shipped code. Therefore `(account_id, provider)` is the universal key throughout P0. **Confirm with Eric/Kevin before execution**; if the answer is "provider-per-appliance first," the cooldown table and dispatch simplify to provider-only.

---

## Task breakdown

### T1 — Interface + canonical type (no DB, no behavior)
- **New:** `dashboard/lib/mail/providers/types.ts` — `MailProvider`, `CanonicalMessage`, `SendRequest`/`SendResult`, `ProviderCapabilities`, `RateLimitHint` (shapes per the ADR).
- **New:** `dashboard/lib/mail/providers/index.ts` — `providerFor(account: { provider: string }): MailProvider` factory. Throws on unknown provider (closed set).
- Pure types + factory; importable but not yet wired. Lands first so the rest compiles against it.

### T2 — Extract `GmailProvider` (dashboard-side only)
- **New:** `dashboard/lib/mail/providers/gmail.ts` implementing `MailProvider`:
  - `normalize(raw)` — lift the inbound→canonical mapping (the field set in `inboxMessageInsertBodySchema`: `message_id, thread_id, from_addr, to_addr, subject, snippet, body, in_reply_to, references, received_at`) into one tested function.
  - `normalizeThreadId(msg)` — Gmail: passthrough of the native thread id.
  - `parseRateLimit(error)` — extract the `Retry after <ISO>` logic currently inlined in `lib/jobs/gmail-ratelimit-sweeper.ts` (the regex + future-timestamp check) into the provider; the sweeper calls `GmailProvider.parseRateLimit`.
  - `capabilities = { nativeThreading: true, push: false, quoteStrategy: 'gmail' }`.
  - `listNew` / `send` / `backfillSent` — **thin delegations documenting that n8n owns Gmail transport in P0** (the methods exist for interface conformance; they call the existing n8n webhook path, they do not reimplement fetch/send). This is the seam without the rip-out.
- **Refactor (behavior-preserving):** `lib/jobs/gmail-ratelimit-sweeper.ts` to call the provider's `parseRateLimit`. Diff should be mechanical.

### T3 — Schema migration (the riskiest part — stage carefully)
- **New:** `dashboard/migrations/037-add-provider-dimension-v1-2026-05-29.sql` (comment block per migration-007 standard: what / why DR-57 / reversal note). Additive + DEFAULT-backfilled, mirroring migration 033's discipline:
  1. `ALTER TABLE mailbox.accounts ADD COLUMN provider text NOT NULL DEFAULT 'gmail' CHECK (provider IN ('gmail','imap','microsoft'))`.
  2. `ALTER TABLE mailbox.accounts ADD COLUMN provider_config jsonb NOT NULL DEFAULT '{}'`.
  3. **Provider-neutral sent id (compatibility-preserving):** `ALTER TABLE mailbox.drafts ADD COLUMN provider_message_id text`; backfill from `sent_gmail_message_id` (migration 015); **keep `sent_gmail_message_id` as-is in P0** because the n8n `Mark Sent` node writes it — renaming it would break the workflow JSON (cross-boundary). Treat `provider_message_id` as the canonical read column; sync via trigger or leave `sent_gmail_message_id` as the n8n write target until P3. *(Flag for review: trigger-sync vs dual-write.)*
  4. **Per-account/provider cooldown:** `CREATE TABLE mailbox.mail_cooldowns (account_id int NOT NULL REFERENCES accounts(id), provider text NOT NULL, until timestamptz, set_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (account_id, provider))`; backfill one row from the current `system_state.gmail_rate_limit_until` for the default account + `'gmail'`. **Keep `system_state.gmail_rate_limit_until` in place behind a compatibility read** for P0 so the live circuit breaker can't regress; cut consumers over to `mail_cooldowns` in the same migration only if S-MP-1 covers them. *(This is the highest-blast-radius change — see Risks.)*
- **Regen:** `npm run db:codegen` → `lib/db/schema.ts`; update `dashboard/test/fixtures/schema.sql` (the codegen source-of-truth snapshot). CI gate: `npm run db:codegen:verify`.

### T4 — Wire dispatch at the V2 account-resolution seam
- In `app/api/internal/draft-prompt/route.ts` (already account-aware post-V2), resolve `providerFor(account)` and use `capabilities.quoteStrategy` where Gmail quote-stripping is currently assumed (`lib/drafting/strip-quoting.ts` call sites). For `gmail` the behavior is identical — this just routes through the capability instead of hardcoding.
- No `if (provider === 'gmail')` anywhere — always `providerFor(...).capabilities.*`.

### T5 — Tests (the S-MP-1 gate)
- **New:** `dashboard/lib/mail/providers/__tests__/gmail.test.ts` — `normalize`, `normalizeThreadId`, `parseRateLimit` (port the sweeper's existing cases), capability shape.
- **Extend:** `test/schema-invariants.test.ts` — assert the `accounts.provider` CHECK matches a `PROVIDERS` const tuple in `lib/types.ts` (new SoT tuple, same pattern as `DRAFT_STATUSES`).
- **Regression (the actual gate):** existing vitest suite (44 cases) + `test/routes/pipeline-smoke.test.ts` stay green; the RAG/eval baselines unchanged. Any drift = the seam is wrong (kill criterion).

### T6 — Docs/decision sync
- Promote NC-35 in the addendum once confirmed; note in `dashboard/CLAUDE.md` that `accounts.provider` ≠ `oauth_tokens.provider`.
- Update the root CLAUDE.md DR table: add DR-55/DR-57 Accepted rows.

---

## Risks & mitigations

| Risk | Why it matters | Mitigation |
|------|----------------|------------|
| **Cooldown reshape regresses the live circuit breaker** | `system_state.gmail_rate_limit_until` gates real sends (STAQPRO-228/231); a bad migration could pause or un-pause sends wrongly | Keep the old column live in P0; add `mail_cooldowns` alongside; cut over only with test coverage. Blast radius: migration 018, `queries-system-state.ts`, sweeper, both cooldown routes, `alerts.ts`, `schema.sql`, `gmail-cooldown.test.ts`. |
| **`sent_gmail_message_id` rename breaks n8n `Mark Sent`** | n8n workflow JSON writes that exact column name (cross-boundary coupling) | Do NOT rename in P0 — ADD `provider_message_id`, keep the old column as n8n's write target until P3. |
| **codegen drift** | `lib/db/schema.ts` must match the new fixture or CI `db:codegen:verify` fails | Regen + commit `schema.ts` and `schema.sql` together in the migration commit. |
| **Interface churn from P1** | IMAP may reveal the interface is wrong | That's the point of S-MP-2 — but P0's S-MP-1 (Gmail green) only proves the *Gmail* shape. Accept that P1 may force one interface revision; keep the interface small. |

---

## Sequencing & commits (atomic, per Commit Engine)

1. `feat(mbox-356): MailProvider interface + provider factory` (T1)
2. `feat(mbox-356): extract GmailProvider; sweeper uses parseRateLimit` (T2)
3. `feat(mbox-356): migration 037 — provider dimension + mail_cooldowns` (T3, incl. codegen)
4. `feat(mbox-356): dispatch quote-strategy via provider capability` (T4)
5. `test(mbox-356): GmailProvider unit + provider CHECK invariant` (T5)
6. `docs(mbox-356): DR-55/57 sync + provider naming note` (T6)

Each commit keeps the suite green. PR title uses **MBOX-356** (the child), never MBOX-355/MBOX-162, to avoid the epic auto-close behavior.

## Definition of done (S-MP-1)

- `npm test` + `npm run db:codegen:verify` green in CI.
- RAG/eval baselines unchanged from pre-P0.
- A manual M1 send round-trip is unchanged (accounts=1, provider=gmail → identical path).
- No `if (provider === ...)` branches; all dispatch via `providerFor().capabilities`.
- `accounts.provider` defaults every existing row to `'gmail'`; `mail_cooldowns` has the backfilled default row.
