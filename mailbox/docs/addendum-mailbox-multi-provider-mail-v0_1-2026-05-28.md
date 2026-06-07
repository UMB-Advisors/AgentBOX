# Addendum: MailBOX Multi-Provider Mail (IMAP/SMTP + Microsoft 365)

> **Target spec:** `mailbox-appliance-spec-v3_0-2026-05-19.md`
> **Companion specs:** `addendum-mailbox-multi-account-v0_1-2026-05-20.md` (the `account_id` substrate this builds on), dashboard `n8n Boundary Contract` (STAQPRO-186, `dashboard/CLAUDE.md`)
> **Companion ADR:** `adr-mailprovider-abstraction-v0_1-2026-05-28.md` (the `MailProvider` seam — DR-55)
> **Addendum started:** 2026-05-28
> **Status:** DRAFT — pending Eric / Kevin review
> **How to use:** This addendum scopes expanding MailBOX from Gmail-only to **any mail provider** — Gmail (today), generic IMAP/SMTP, and Microsoft 365 (Graph). Sections marked AMEND modify existing PRD requirements; NEW introduce structure that does not yet exist. Decision Records continue the shared namespace at **DR-55**; Success Metrics at **SM-91**; open questions at **NC-33**. Content is tiered: **Accepted** decisions are committed; **Candidate** decisions are gated on the spikes in §7 and must not be promoted without evidence.

---

## TL;DR

- The pipeline core (classify, draft, RAG, urgency, digest, approval queue, audit) is **already provider-agnostic** — it operates on rows in `mailbox.inbox_messages` / `mailbox.drafts`, never on Gmail directly. Gmail coupling is concentrated at **four edges**: ingress (read), egress (send), the rate-limit circuit breaker, and threading/quoting.
- The leverage move is **not** to fork the pipeline per provider. It is a single `MailProvider` abstraction (DR-55) with three implementations — `GmailProvider` (extracted, behavior-preserving), `ImapSmtpProvider`, `MicrosoftGraphProvider` — and a `provider` column made first-class alongside the `account_id` dimension that landed today (migration 033, MBOX-348).
- Multi-provider is the **forcing function** for STAQPRO-187 (the already-tracked "narrow the n8n boundary" spike): provider I/O is exactly the surface that doc says is "small enough to reimplement in a single sprint."
- Phasing: **P0** extract the Gmail seam (no new provider — de-risks everything) → **P1 IMAP/SMTP** (universal reach, lowest lift) → **P2 Microsoft Graph** (highest-value ICP) → **P3 (gated)** retire provider-specific n8n nodes.

---

## Change Log

| Date | Section | Summary |
|------|---------|---------|
| 2026-05-28 | §1 (NEW) | Problem framing — reach beyond Google Workspace |
| 2026-05-28 | §2 (NEW) | The four Gmail-coupled edges (grounded in code) |
| 2026-05-28 | §3 (NEW) | Phasing — P0 seam → IMAP → Microsoft → n8n collapse |
| 2026-05-28 | §4 (AMEND) | Schema — `provider` as a first-class dimension |
| 2026-05-28 | §5 (NEW) | Cross-cutting requirements (threading, rate-limit, auth, idempotency) |
| 2026-05-28 | §6 (NEW) | Provider matrix — Gmail vs IMAP/SMTP vs Microsoft Graph |
| 2026-05-28 | §7 (NEW) | Validation spikes + kill criteria |
| 2026-05-28 | DR-55 → DR-58 (NEW) | Abstraction, n8n boundary, provider dimension, IMAP auth |
| 2026-05-28 | SM-91 → SM-95 (NEW) | Success metrics |
| 2026-05-28 | NC-33 → NC-38 (NEW) | Open questions |

---

## §1. Problem Framing (NEW)

MailBOX today assumes Google Workspace end-to-end: OAuth via a per-customer GCP project, n8n Gmail nodes for read/send, Gmail thread IDs as the conversation key, and a circuit breaker tuned to Gmail's 429 `Retry-After`. The live fleet (M1 Heron Labs) is Gmail. That is a hard ceiling on the addressable market: the small-business operator who runs a **custom domain on cPanel/Fastmail/Zoho** (IMAP/SMTP) or — more importantly for the ICP — **Microsoft 365** cannot buy the product.

The requirement is *not* "support another API." It is **decoupling the pipeline from the mail transport** so that the same classify→draft→approve→send loop runs regardless of where the mail lives, and so that adding a fourth provider later is a new class, not a new fork.

Two providers are in scope for this addendum:
- **IMAP/SMTP** — the lowest common denominator. Covers every custom-domain operator and most non-Google/non-Microsoft hosts. No per-provider API integration; one protocol covers all.
- **Microsoft 365 (Graph API)** — the highest-value non-Gmail segment. The SMB operator on Outlook/Exchange Online is the single largest cohort we currently cannot serve.

This composes with — and depends on — **MBOX-162 multi-account** (the `account_id` dimension shipped today in migration 033). Provider is a *second axis*: an appliance may run a Gmail account and an Outlook account side by side. See NC-35 for the v1 scope question on simultaneous mixed-provider operation.

---

## §2. The Four Gmail-Coupled Edges (NEW, grounded in code)

The coupling is real but bounded. Mapped against the live tree:

| Edge | Where it lives (live code) | What is Gmail-specific | Generalization |
|------|---------------------------|------------------------|----------------|
| **Ingress (read)** | `MailBOX.json` `Gmail Get` node; bootstrap throttle (`/api/internal/gmail-bootstrap`, `/api/internal/gmail-cycle-complete`); history backfill (`MailBOX-FetchHistory` + `dashboard/lib/onboarding/gmail-history-backfill.ts`, `q=in:sent after:…`) | Gmail list/get JSON shape, `historyId`, label-filter query syntax | `MailProvider.listNew()` / `.backfillSent()` returning canonical messages |
| **Egress (send)** | `MailBOX-Send` → `Gmail Reply`; `MailBOX-Digest` Gmail send; idempotency lock (`drafts.send_attempt_at`, migration 025) | Gmail Reply threading (`threadId`, `In-Reply-To`), `gmail_message_id` on success | `MailProvider.reply()` / `.send()`; lock stays provider-neutral (it guards the call, not the call's shape) |
| **Rate-limit circuit breaker** | `dashboard/lib/jobs/gmail-ratelimit-sweeper.ts`; `system_state.gmail_rate_limit_until`; `/api/{internal,system}/gmail-cooldown`; `transitions.ts` gate (STAQPRO-231) | Regex-parses **Gmail's** `Retry after <ISO>` from n8n `execution_data`; +60-min safety buffer (STAQPRO-228); read/send buckets independent | `MailProvider.parseRateLimit(error)`; cooldown keyed per `(account_id, provider)` in `system_state` |
| **Threading / quoting** | `dashboard/lib/drafting/thread-history.ts` (keys on `thread_id` = Gmail thread id); `strip-quoting.ts` (Gmail quote format); `queries-thread.ts` | `thread_id` is Gmail's; quote-strip heuristics tuned to Gmail's `On … wrote:` blocks | Canonical `thread_id` synthesized per provider; per-provider quote-strip strategy |

**Everything else is already agnostic.** `drafts`, `state_transitions`, `classification_log`, persona resolver, Qdrant RAG (keyed on `message_id`), urgency engine, digest renderer — none reference Gmail. This is the whole reason multi-provider is tractable: the blast radius is the four edges above plus the identity/credential plumbing in §4.

---

## §3. Phasing (NEW)

Sequenced by dependency and risk. Each phase is independently shippable and leaves Gmail green.

| Phase | Delivers | Why this order | Depends on |
|-------|----------|----------------|------------|
| **P0 — Provider seam** | Extract today's Gmail logic behind the `MailProvider` interface (DR-55). **No new provider, no behavior change.** Generalize schema (§4). | De-risks all later work: if the existing eval suite stays green after extraction, the seam is correct before any new provider touches it. | migration 033 (`accounts`, `oauth_tokens`) — shipped |
| **P1 — IMAP/SMTP** | `ImapSmtpProvider`. Inbound poll via IMAP, send via SMTP, threading synthesized from `Message-ID`/`References` headers. | Universal reach, **lowest lift** (one protocol covers all hosts), and it stress-tests the seam against a provider with *no native thread model* — the hardest normalization case. If the seam survives IMAP, Graph is easy. | P0 |
| **P2 — Microsoft Graph** | `MicrosoftGraphProvider`. OAuth2 (Azure app reg), native `conversationId`, `sendMail`/`reply`. Optional change-notification subscriptions (webhooks) deferred — poll first (NC-36). | Highest-value ICP, but heavier (Azure app registration, consent model). Lands after the seam is proven on the harder IMAP case. | P0 |
| **P3 — n8n collapse (gated)** | Retire provider-specific n8n ingress/egress nodes; dashboard owns the poll loop + send per DR-56. | Only if per-provider n8n workflow sprawl becomes the maintenance tax. Decision deferred to a spike — see DR-56 / §7. | P1, P2, STAQPRO-187 |

---

## §4. Schema — `provider` as a First-Class Dimension (AMEND)

Migration 033 made `account_id` first-class and added `mailbox.accounts` + `mailbox.oauth_tokens`. Multi-provider extends that substrate; it does **not** introduce a parallel one.

**Required changes (one migration, additive + non-breaking, mirroring 033's DEFAULT-backfill discipline):**

1. **`mailbox.accounts.provider`** — `TEXT NOT NULL DEFAULT 'gmail'` with a CHECK in `('gmail','imap','microsoft')`. Every existing account backfills to `'gmail'` (deterministic — M1 is Gmail). This is the single discriminator the pipeline and `MailProvider` factory key off.
2. **`mailbox.accounts.provider_config`** — `JSONB DEFAULT '{}'`. Provider-specific connection params (IMAP host/port/TLS; Graph tenant id / scopes). No secrets here — secrets go to `oauth_tokens` / the credential store.
3. **Rename the Gmail-specific identity columns to provider-neutral** (with a transition view, per the migration-007 comment standard):
   - `drafts.gmail_message_id` → `provider_message_id` (the sent message's id, whatever the provider calls it).
   - `system_state.gmail_rate_limit_until` → per-`(account_id, provider)` cooldown. Either widen `system_state` to a keyed table or add a `mail_cooldowns(account_id, provider, until, set_at)` table. **Recommend the latter** — the single-row global cooldown does not survive a mixed-provider appliance (a Gmail 429 must not pause the Outlook account).
4. **`inbox_messages` / `sent_history` dedup key** becomes `(account_id, provider_message_id)`. Gmail message ids are globally unique; IMAP `Message-ID` is not guaranteed unique across accounts → scope the uniqueness constraint per account.
5. **`thread_id` stays** but its provenance is provider-dependent (Gmail thread id / Graph `conversationId` / synthesized hash of the IMAP `References` root). The column contract is unchanged; the *writer* differs per provider.

**Non-breaking by design** (same lever migration 033 used): every new column carries a Gmail-compatible DEFAULT, so today's single-Gmail writers keep working untouched; only the new provider adapters override the defaults.

---

## §5. Cross-Cutting Requirements (NEW)

These are the requirements that span all providers — the ones most likely to bite in production.

| Ref | Requirement | Notes |
|-----|-------------|-------|
| **FR-MP-1** | Threading normalization | Canonical `thread_id` for every provider. Gmail → thread id; Graph → `conversationId`; IMAP → deterministic hash of the `References` chain root, falling back to `In-Reply-To`, then the message's own id (a new thread root). **As-built (T2):** the subject-normalization last-resort fallback was *deliberately omitted* — it risks false-merging unrelated mail. `thread-history.ts` keys on this unchanged. |
| **FR-MP-2** | Quote/signature stripping — sender-driven, NOT operator-provider | **Corrected 2026-05-29 (T4):** quote format is set by the *counterparty's* client, not the operator's account provider — a Gmail operator routinely receives Outlook/Apple/mobile-formatted replies. `strip-quoting.ts` **already** matches all those patterns (Gmail `On…wrote:`, Outlook `From:/Sent:`, forwarded blocks, `>`-quoting, sig delim) and **stays sender-agnostic** (try-all, fail-open). So there is **no per-operator-provider dispatch** — that would *drop* coverage IMAP operators need. `MailProvider.capabilities.quoteStrategy` is **reserved/informational** — a future hook to *add* provider-specific patterns (e.g. a Graph quirk in P2), never to restrict. P1 IMAP needs no new pattern → **T4 is a spec correction, no code.** |
| **FR-MP-3** | Per-provider rate-limit / backoff | Gmail 429 `Retry-After` (live); Graph returns its own `Retry-After` + throttling status; IMAP/SMTP rarely 429 but enforce connection/login throttles. `parseRateLimit()` per provider; cooldown keyed per account (§4.3). The +60-min safety buffer (STAQPRO-228) is Gmail-specific tuning — make it a per-provider constant. |
| **FR-MP-4** | Idempotent send | `drafts.send_attempt_at` CAS lock (migration 025) is provider-neutral and **stays as-is**. Only the guarded call changes. Each provider must return a stable sent-message id to clear the lock and write `provider_message_id`. |
| **FR-MP-5** | Credential storage + refresh | Gmail/Graph OAuth refresh tokens and IMAP/SMTP app-passwords live encrypted (n8n credential store today, or `mailbox.oauth_tokens` from migration 033 if P3 moves I/O into the dashboard). The `N8N_ENCRYPTION_KEY` single-point-of-loss caveat (per the boundary contract) applies to all providers. |
| **FR-MP-6** | Per-provider onboarding/connect | Onboarding wizard (MBOX-216) gains a provider picker. Gmail → existing OAuth consent; Microsoft → Azure consent (delegated vs app-only, NC-34); IMAP → host/port/username/app-password form + a test-connection probe. |
| **FR-MP-7** | Privacy gate unchanged | RAG cloud-gating (`RAG_CLOUD_ROUTE_ENABLED`) and thread-history cloud-gating are provider-agnostic — they gate on *route*, not transport. No change. All providers keep mail on-appliance. |
| **FR-MP-8** | Digest send generalization | `MailBOX-Digest` Gmail send → `MailProvider.send()` for the operator's chosen account/provider. |

---

## §6. Provider Matrix (NEW)

| Capability | Gmail (today) | IMAP/SMTP | Microsoft Graph |
|------------|---------------|-----------|-----------------|
| **Reach** | Google Workspace / gmail.com | Universal (any IMAP host) | Microsoft 365 / Exchange Online |
| **Auth** | OAuth2 (per-customer GCP client; shared client tracked in STAQPRO-197) | App-password / basic-auth; OAuth-IMAP (XOAUTH2) for Gmail/Yahoo (NC-33) | OAuth2, Azure app registration; delegated or app-only (NC-34) |
| **Inbound** | `Gmail Get` (poll) | IMAP `SEARCH`/`FETCH` (poll); IDLE optional | Graph `messages` list (poll); change-notification subscriptions optional (NC-36) |
| **Send / reply** | Gmail Reply | SMTP `sendmail` | Graph `sendMail` / `reply` |
| **Native threading** | Yes (thread id) | **No** — reconstruct from headers (FR-MP-1) | Yes (`conversationId`) |
| **Rate-limit shape** | 429 `Retry-After`, per-user buckets | Connection/login throttle, host-specific | 429 `Retry-After` + throttling guidance |
| **Push available** | (Pub/Sub KILLED, DR-22 — we poll) | IMAP IDLE (flaky across hosts) | Webhook subscriptions (renewal complexity) |
| **Quote format** | `On … wrote:` | Client-dependent | `From:/Sent:/To:` blocks |
| **Relative lift** | baseline | **Low–medium** | **Medium** |

---

## §7. Validation Spikes + Kill Criteria (NEW)

Per the project's spike-gate discipline (mirrors the multi-account §6). Candidate DRs do not promote without evidence.

| Spike | Question | Pass | Kill |
|-------|----------|------|------|
| **S-MP-1 (P0)** | Does extracting `GmailProvider` behind the interface preserve behavior? | Existing eval suite + pipeline smoke green; M1 send round-trip unchanged | Any regression in draft quality or send reliability → the seam is wrong, redesign before P1 |
| **S-MP-2 (P1)** | Can IMAP threading be reconstructed reliably from headers? | ≥95% of test-corpus replies land in-thread in the counterparty's client | Header chains too sparse/broken to thread → ship IMAP as flat (no thread context) + flag the degraded mode |
| **S-MP-3 (P2)** | Delegated vs app-only Graph consent — which clears Microsoft's review for a sold appliance? | A test M365 tenant completes inbound→draft→approve→send | Neither consent model is viable without per-customer Azure admin friction → descope Microsoft to "BYO app registration" for v1 |
| **S-MP-4 (DR-56)** | Is dashboard-owned provider I/O worth retiring n8n ingress? | A `setInterval` poll + one provider adapter matches n8n reliability over a 48h soak | n8n parity not reached in a sprint → keep n8n at the edge (Option A), per-provider workflows — **DECIDED 2026-05-29: Option A (n8n) for P1 (desk analysis, see DR-56). Residual on-box check before T5 ships: stand up `emailReadImap` against a test mailbox + confirm poll→handoff reliability.** |

---

## Decision Records

> **DR-55 (Accepted) — `MailProvider` abstraction is the integration seam.**
> All provider-specific read / normalize / send / threading / rate-limit logic implements one TypeScript interface in `dashboard/lib/mail/providers/`. The pipeline core stays provider-agnostic and keys off the normalized canonical message + `accounts.provider`. Full rationale + interface shape in the companion ADR (`adr-mailprovider-abstraction-v0_1-2026-05-28.md`).

> **DR-56 (Resolved 2026-05-29 — Option A / n8n for P1; dashboard-owned cutover deferred) — where provider I/O runs.**
> **Decision:** for P1 IMAP (and P2 Graph), ingress/egress run in **n8n** via per-provider workflows (`MailBOX-Imap`, `MailBOX-Graph`) selected by `accounts.provider`; normalization stays in the dashboard's `MailProvider` (already TS-tested). The dashboard-owned poll-loop cutover (STAQPRO-187's "rip out n8n ingress") is **deferred** — revisit when ≥3 providers exist or per-provider workflow sprawl becomes the maintenance tax.
> **Rationale (S-MP-4 desk analysis; on-box empirical check still pending — see §7):** (1) the appliance is dependency-light by constraint (no `googleapis`; raw-fetch OAuth) — Option B adds `imapflow` + `nodemailer` (stateful TCP/SMTP deps) with no offsetting benefit yet; (2) the testability that motivated the seam is already banked — normalization + threading live in TS regardless of where I/O runs; (3) n8n already owns Gmail I/O, so an IMAP workflow is incremental, not a new pattern; (4) `n8n-nodes-base.emailReadImap` + `Send Email (SMTP)` are mature nodes → low empirical risk. The kill-n8n cutover only pays off at multi-provider scale — premature at one new provider.

> **DR-57 (Accepted) — Provider is a first-class dimension alongside account.**
> `mailbox.accounts.provider` enum; per-`(account_id, provider)` cooldown (retire the single global `gmail_rate_limit_until`); `gmail_message_id` → `provider_message_id`; dedup scoped per account. Extends migration 033's substrate, does not parallel it.
> **Delivery split (2026-05-29):** P0 (migration 037, MBOX-356) lands `accounts.provider` + `provider_config` only — the discriminator the `MailProvider` factory needs. The cooldown reshape (`mail_cooldowns(account_id, provider)`) and `provider_message_id` are **deferred to P1 (MBOX-357)**, the phase that first consumes them, to avoid landing dead schema and to keep P0 off the live circuit-breaker tables.

> **DR-58 (Candidate, gated on NC-33) — IMAP auth strategy.**
> Default to app-password / basic-auth IMAP for v1 (covers cPanel/Fastmail/Zoho). Add XOAUTH2 only if a target customer's host (Gmail-IMAP, Yahoo) has deprecated basic-auth. Do not build a general OAuth-IMAP layer speculatively.

---

## Success Metrics

| Ref | Metric |
|-----|--------|
| **SM-91** | An IMAP/SMTP account completes inbound→classify→draft→approve→send on the M1 test rig. |
| **SM-92** | A Microsoft 365 account completes the same round-trip. |
| **SM-93** | Threading correctness: replies land in-thread in the counterparty's client on all three providers (FR-MP-1). |
| **SM-94** | Zero regression on the Gmail path post-abstraction — existing eval baselines + pipeline smoke green (the P0 gate). |
| **SM-95** | A mixed-provider appliance (Gmail + Outlook concurrently) processes both inboxes without cross-provider cooldown bleed (validates §4.3). |

---

## Open Questions

| Ref | Question |
|-----|----------|
| **NC-33** | IMAP auth: app-password only, or XOAUTH2 for hosts that deprecated basic-auth (Gmail-IMAP, Yahoo)? Drives DR-58. |
| **NC-34** | Microsoft consent model: delegated OAuth (per-user consent) vs app-only (admin consent + `Mail.ReadWrite` application permission)? Who owns the Azure app registration — a Staqs multi-tenant app, or per-customer? |
| **NC-35** | ✅ **RESOLVED 2026-05-29 — compose.** Multi-provider composes with multi-account: `(account_id, provider)` is the universal key. Rationale: V2 (MBOX-352) already made `account_id` a first-class scoping key, so a non-composing design would contradict shipped code. One appliance may run Gmail + Outlook concurrently (SM-95). |
| **NC-36** | Microsoft ingress: poll-only first, or build change-notification subscriptions (webhooks need Caddy endpoint + renewal lifecycle)? |
| **NC-37** | SMTP send deliverability: send via the customer's own SMTP (SPF/DKIM aligned to their domain) — confirm no relay/reputation layer is needed. |
| **NC-38** | Does the shared-OAuth-client plan (STAQPRO-197, Gmail) extend to a shared Microsoft multi-tenant app, or stay per-customer? |

---

## Linear

No existing multi-provider track (confirmed 2026-05-28 scan). Closest prior art: **MBOX-162 multi-account** (the `account_id` substrate, V1 shipped today as MBOX-348). This addendum proposes a **new epic** parented under the platform/M6 area, sequenced after multi-account V1. Recommended children mirror the phases: P0 seam, P1 IMAP, P2 Microsoft, P3 n8n-collapse (gated). File the epic before P0 implementation per the repo coordination protocol.
