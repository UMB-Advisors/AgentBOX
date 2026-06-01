# Roadmap — Unified Inbox
Source PRD: unified-inbox-prd.v0.1.0.md (v0.2.0, 2026-06-01)
Milestone: Unified Inbox v1 — channel-agnostic native inbox

> Locked decisions (PRD §Decisions): D1 all channels · D2 native-merge the queue into the dashboard, retire the `/dashboard` iframe · D3 hybrid, n8n normalizes (Hermes platform adapters RECEIVE social → forward to one n8n ingest webhook; email enters n8n directly) · D4 EXTEND the existing Keys/Env page for creds · D5 reuse-first.

---

## Phase 0: Channel-agnostic schema
- **Depends on:** none
- **Deliverables:**
  - Migrations in the `mailbox` schema: new `accounts` table (`id, channel, display_name, identity, credential_ref, enabled, created_at`); new unified `credentials` table (`id, kind, provider, account_ref, secret_enc, scopes, status, last_verified_at`); generalized `inbox_messages` (add `channel, account_id, external_id, sender, recipient, thread_ref, received_at, classification, metadata jsonb`; `subject` nullable); generalized `drafts` (add `channel, account_id`; status machine pending/approved/sent/rejected preserved).
  - Backfill migration tagging all existing email rows `channel='email'`.
- **Acceptance criteria (pass/fail):**
  - [ ] Migrations apply cleanly to a copy of the `mailbox` Postgres with zero errors and are reversible (down migration restores prior schema).
  - [ ] After backfill, every pre-existing `inbox_messages` and `drafts` row has `channel='email'` and a non-null `account_id`; row counts are unchanged from pre-migration.
  - [ ] The existing email pipeline (n8n MailBOX poll/classify → `inbox_messages` → `drafts`) runs end-to-end on the new schema and writes a new email message + draft without error. *(PRD Phase 0 Exit: "existing email pipeline still works on the new schema.")*
  - [ ] `drafts.status` still transitions pending→approved→sent and pending→rejected on the new schema.
- **Execution path:** dynamic-workflow  *(meets routing profile: DB migration + high cost of a wrong answer on the live email pipeline; wants adversarial checking before apply. Surface token-cost premium before kickoff per Operating Rule 4.)*
- **Cost note:** Build: schema design + reversible migrations + backfill. Operating: one-time migration window; encrypted-at-rest `credentials` adds a key-management dependency. Opportunity: foundation gating every later phase — must land first.

---

## Phase 1: Native inbox (replace the iframe), email-only
- **Depends on:** Phase 0
- **Deliverables:**
  - Dashboard API on the AgentBOX server (`hermes_cli/web_server.py`): `/api/inbox/*`, `/api/drafts/*`, `/api/accounts/*`, `/api/credentials/*` reading/writing the mailbox Postgres (extend `web_server.py` per PRD recommendation), replacing the iframed Next.js queue API.
  - Native React pages in `hermes-agent/web`: unified Incoming Messages inbox (with per-channel filter scaffold) + message/draft detail with edit/approve/reject/send for email.
  - Removal of the `/dashboard` iframe proxy and `InboxPage`.
- **Acceptance criteria (pass/fail):**
  - [ ] An email message in `mailbox.inbox_messages` renders in the native Incoming Messages page (no iframe in the DOM/route tree).
  - [ ] Its draft can be edited, approved, rejected, and sent from the native detail page, and each action writes the corresponding `drafts.status` transition to Postgres.
  - [ ] `/api/inbox`, `/api/drafts`, `/api/accounts`, `/api/credentials` each return 200 with correct payloads against the mailbox DB; `/api/credentials` never returns `secret_enc` to the client.
  - [ ] The `/dashboard` iframe proxy route and `InboxPage` are deleted from the codebase (grep returns no live references). *(PRD Phase 1 Exit: "email triage/draft/approve fully native; iframe gone.")*
- **Execution path:** single-pass  *(scoped feature build — API endpoints + React pages within known files; not a codebase-wide sweep or migration.)*
- **Cost note:** Build: API endpoints + React pages + iframe teardown. Operating: dashboard server now owns mailbox-PG connections. Opportunity: delivers the visible win (native email inbox) and retires the iframe shipped earlier.

---

## Phase 2: Channels via the hybrid pipeline (iterative)
- **Depends on:** Phase 0, Phase 1
- **Deliverables:**
  - Built once: an n8n **ingest webhook** + a generalized **normalize→classify→draft→write-to-`inbox_messages`/`drafts`** step serving every channel.
  - A thin **forward-to-n8n bridge** in the Hermes `platforms` adapters that POSTs received social messages to the ingest webhook.
  - Channel onboarding in waves reusing existing connectivity: (a) multi-account email via n8n direct; (b) Telegram/Discord/Slack via adapter→bridge→webhook; (c) WhatsApp/Signal/SMS; (d) Teams/Matrix/others.
- **Acceptance criteria (pass/fail):**
  - [ ] The n8n ingest webhook accepts a normalized payload and writes a `channel`-tagged row to `inbox_messages` plus a `drafts` row, for at least one non-email channel.
  - [ ] **Per onboarded wave:** an inbound message on that channel appears in the native unified inbox with a generated draft, and approve→send delivers a reply back on that same channel. *(PRD Phase 2 Exit per wave: "that channel's inbound appears in the native inbox with a draft, and approve→send delivers back on it.")*
  - [ ] Multi-account email: messages from ≥2 distinct connected email accounts appear as separate `account_id`s in the unified inbox.
  - [ ] The unified inbox per-channel filter returns only rows matching the selected `channel`.
- **Execution path:** dynamic-workflow  *(meets routing profile: repeating work fanned across many channel adapters/files and long-running iterative wave onboarding with checkpointed progress. Each wave gates on its own per-wave acceptance criteria, not calendar. Surface token-cost premium before kickoff.)*
- **Cost note:** Build: bridge + generalized n8n normalize step (per D3/D5, not ~10 from-scratch integrations). Operating: each channel adds an account/credential + n8n flow to maintain; WhatsApp/Signal/SMS provisioning is heavier than bot-token channels. Opportunity: the long tail — value compounds per wave; can pause between waves without blocking Phase 4.

---

## Phase 3: Extend the Keys/Env page for all creds
- **Depends on:** Phase 0, Phase 2
- **Deliverables:**
  - Extensions to the existing `EnvPage` (D4/D5): channel **accounts** + **app-passwords** added as new provider groups / OAuth entries alongside the existing `OAuthProvidersCard` and `ProviderGroupCard`.
  - Add/rotate/**test-connection** actions per credential, writing through to the existing env/OAuth backends + the new `credentials` table + the n8n credential API.
  - A documented threat model for the credential write-through surface (encryption at rest, no secret readback, audit) produced before build, per PRD Key risks.
- **Acceptance criteria (pass/fail):**
  - [ ] Every enabled channel's credentials are addable, rotatable, and testable from the Keys/Env page (no separate page exists). *(PRD Phase 3 Exit: "every channel's creds managed from the Keys page; tests pass.")*
  - [ ] The **test-connection** action returns a pass/fail result per credential and updates `credentials.status` (connected|expired|missing) and `last_verified_at` accordingly.
  - [ ] A rotate action updates `secret_enc` in the `credentials` table and the corresponding n8n stored credential; the old secret no longer authenticates on a subsequent test.
  - [ ] No credential `secret_enc` value is ever returned to the client in any `/api/credentials` response (verified by inspecting payloads).
  - [ ] The threat model document exists and is referenced before any credential-write code is merged.
- **Execution path:** dynamic-workflow  *(meets routing profile: security-critical, high-cost-of-error credential write-through — PRD mandates threat-modeling first; wants independent attempts + refutation. Surface token-cost premium before kickoff.)*
- **Cost note:** Build: page extensions + rotate/test plumbing + threat model. Operating: this is the riskiest surface (token/app-password rotation, encryption at rest, audit) — ongoing security responsibility. Opportunity: unifies fragmented creds (Hermes EnvPage + MailBOX `.env` + n8n) into one managed surface.

---

## Phase 4: Per-channel send path
- **Depends on:** Phase 0, Phase 1, Phase 2, Phase 3
- **Deliverables:**
  - Approve→send routing back to the originating channel: n8n send flows for email (SMTP/Gmail) and per-channel outbound reusing the platform adapters' existing send (Telegram bot, Slack, etc.) per D5.
- **Acceptance criteria (pass/fail):**
  - [ ] Approving a pending draft delivers the reply on the **same channel and account** the source message arrived on, for every enabled channel. *(PRD Phase 4 Exit: "approved drafts deliver on every enabled channel.")*
  - [ ] On successful delivery the draft's status is set to `sent`; on send failure the status is not set to `sent` and the failure is surfaced to the UI.
  - [ ] Email approve→send delivers via the n8n email send flow; at least one social channel approve→send delivers via the reused platform-adapter outbound.
- **Execution path:** single-pass  *(scoped: wire approve→send to existing n8n send flow + existing adapter outbound; reuse-first per D5, not codebase-wide.)*
- **Cost note:** Build: send routing per channel (mostly reuse of existing outbound). Operating: each enabled channel's send path is a deliverability surface to monitor. Opportunity: closes the loop — the inbox becomes fully bidirectional across all channels.
