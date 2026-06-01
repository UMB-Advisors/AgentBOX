# Unified Inbox — PRD

**Version:** 0.2.0
**Date:** 2026-06-01
**Status:** Draft — architecture locked via decisions below; phasing for review
**Targets:** MailBOX (Postgres schema + n8n) · AgentBOX/Hermes dashboard (`hermes-agent/web`) · mailbox-dashboard (absorbed)

---

## TL;DR

Rebuild the MailBOX approval queue into a **single, native, channel-agnostic Inbox** inside the
AgentBOX dashboard. Every inbound message — across **multiple email accounts and every social/chat
channel** (Telegram, Discord, Slack, WhatsApp, Signal, SMS, Teams, Matrix, …) — lands in one
Postgres inbox, is **triaged and drafted uniformly**, and is approved/sent from native dashboard
pages (no more iframe). n8n stays the ingestion/draft/send engine. All OAuth + API keys + app
passwords live on **one unified Credentials page** in Settings (connect / rotate / test).

This is a large, multi-phase effort. Deliver incrementally: schema → native email inbox →
per-channel adapters → unified credentials → per-channel send.

---

## Decisions (locked 2026-06-01)

| # | Decision | Choice |
|---|---|---|
| D1 | Channels | **All** — multi-account email + Telegram/Discord/Slack + WhatsApp/Signal/SMS + Teams/Matrix/others |
| D2 | Architecture | **Native-merge** the queue into the AgentBOX dashboard (no iframe); channel-agnostic schema; adapters feed one inbox |
| D3 | Engine | **Hybrid, n8n normalizes** (revised v0.2). Hermes **platform adapters RECEIVE** social inbound and forward to an n8n ingest webhook; **n8n** (email + social) does normalize/classify/draft/inbox-write — **one pipeline** for every channel. Email enters n8n directly as today. |
| D4 | Credentials | **Extend the existing Keys/Env page** (it already does OAuth + per-provider API keys via `OAuthProvidersCard`/`ProviderGroupCard`) to cover channel accounts + app-passwords (add/rotate/test). **Not a new page.** |
| D5 | Reuse-first | Piggyback on existing Hermes features wherever possible — Keys/Env page, `platforms` adapters, agent drafting, sessions/threads, dashboard `api.ts`/Card patterns. Minimize net-new code. |

---

## Current state (what we're integrating)

- **MailBOX (email):** n8n "MailBOX" workflow (Gmail poll + classify) → Postgres
  `mailbox.inbox_messages` (email-shaped: `from_addr`, `subject`, `thread_id`) → `mailbox.drafts`
  → mailbox-dashboard `/dashboard/queue` (separate Next.js app, today iframed at `/dashboard`).
  Partial multi-account/IMAP support exists (`N8N_IMAP_WEBHOOK_URL`).
- **Hermes platforms plugin:** bidirectional adapters for Discord, Slack, Telegram, Teams, Matrix,
  Mattermost, IRC, Line, Google Chat, ntfy, SimpleX, WhatsApp, Signal — but wired to the
  *conversational agent*, not the triage/draft/approve queue.
- **Credentials:** split across Hermes `EnvPage` (Keys) + `OAuthProvidersCard`, MailBOX `.env`,
  and n8n stored credentials.

The integration gap: two inbound systems built separately + an email-only schema + an iframed UI +
fragmented credentials.

---

## Target architecture

```
 channel adapters (n8n)                     unified store (Postgres `mailbox`)        native UI (AgentBOX dashboard)
 ┌──────────────────────────┐               ┌───────────────────────────────┐        ┌───────────────────────────┐
 │ email (Gmail/IMAP) ×N     │  normalize    │ accounts (channel, identity,   │  API   │ Inbox (unified + per-      │
 │ telegram / discord / slack│ ───────────▶ │   credential_ref)              │ ◀────▶ │   channel filter)         │
 │ whatsapp / signal / sms   │   INSERT      │ inbox_messages (channel-       │        │ Message + Draft review    │
 │ teams / matrix / …        │               │   agnostic; metadata jsonb)    │        │   (edit/approve/reject)   │
 └──────────────────────────┘               │ drafts (channel-agnostic)      │        │ Settings ▸ Credentials    │
            ▲  classify + draft (n8n)         │ credentials (oauth/key/apppw)  │        └───────────────────────────┘
            └─────────────────────────────────┴───────────────────────────────┘
                       approve ──▶ n8n per-channel SEND workflow ──▶ channel
```

### Data model (channel-agnostic)

- **`accounts`** *(new)* — one row per connected identity: `id, channel, display_name, identity,
  credential_ref, enabled, created_at`. (e.g. `email:dustin@…`, `telegram:@bot`, `slack:WS123`).
- **`inbox_messages`** *(generalize)* — add `channel`, `account_id`, `external_id`, `sender`,
  `recipient`, `thread_ref`, `received_at`, `classification`, `metadata jsonb`; `subject` becomes
  nullable (email-only); legacy email columns kept or folded into `metadata`.
- **`drafts`** *(generalize)* — `channel`, `account_id`, `inbox_message_id`, `body`, `status`
  (pending/approved/sent/rejected), timestamps. Status machine stays.
- **`credentials`** *(new, unified)* — `id, kind (oauth|api_key|app_password), provider,
  account_ref, secret_enc, scopes, status (connected|expired|missing), last_verified_at`. Backs the
  Settings page; secrets encrypted at rest, never returned to the client.

### Components

1. **Schema migrations** (`mailbox` schema) — the backbone (above).
2. **Ingestion (hybrid, D3).** **Email** enters n8n directly (Gmail/IMAP, as today). **Social**
   reuses Hermes **`platforms` adapters** to receive, then a thin **forward-to-n8n bridge** POSTs
   each message to a single n8n **ingest webhook**. n8n then runs **one** normalize→classify→draft→
   `inbox_messages`/`drafts` pipeline for every channel. **Send:** n8n send flow for email; reuse
   the platform adapters' existing outbound for social (approve → adapter send). New code is the
   bridge + the generalized n8n normalize step — not ~10 channel integrations.
3. **Dashboard API** — the AgentBOX dashboard server (`hermes_cli/web_server.py`) gains
   `/api/inbox/*`, `/api/drafts/*`, `/api/accounts/*`, `/api/credentials/*` reading/writing the
   mailbox Postgres (or absorbs the mailbox-dashboard API). Replaces the iframed Next.js queue.
4. **Native dashboard pages** — rebuild the queue as React pages in `hermes-agent/web`: Incoming
   Messages (unified inbox + per-channel filter), message/draft detail (edit/approve/reject/send).
   Retire the `/dashboard` iframe proxy + `InboxPage`.
5. **Credentials — extend the Keys/Env page** (D4/D5). Build on the existing `EnvPage` (OAuth
   section via `OAuthProvidersCard`; per-provider API-key groups via `ProviderGroupCard`). Add
   channel **accounts** + **app-passwords** as new provider groups / OAuth entries, with
   add/rotate/**test**. Writes through to the existing env/OAuth backends + the new `credentials`
   table + n8n credential API. No separate page.

---

## Phases (incremental, gated)

### Phase 0 — Channel-agnostic schema
Migrations for `accounts`, generalized `inbox_messages`/`drafts`, `credentials`. Backfill existing
email rows (channel='email'). **Exit:** existing email pipeline still works on the new schema.

### Phase 1 — Native inbox (replace the iframe), email-only
Dashboard API (`/api/inbox`, `/api/drafts`, …) over the mailbox DB + native React Inbox/Draft pages
in AgentBOX. Approve/edit/reject/send for email. Retire the `/dashboard` iframe. **Exit:** email
triage/draft/approve fully native; iframe gone.

### Phase 2 — Channels via the hybrid pipeline, iterative
Build the n8n **ingest webhook + generalized normalize→classify→draft** step ONCE, then onboard
channels in waves by reusing existing connectivity: **(a) multi-account email** (n8n direct),
**(b) Telegram/Discord/Slack** (platform adapter → bridge → webhook), **(c) WhatsApp/Signal/SMS**,
**(d) Teams/Matrix/others**. The per-channel work is mostly the thin forward-to-n8n bridge, not new
ingestion. **Exit per wave:** that channel's inbound appears in the native inbox with a draft, and
approve→send delivers back on it.

### Phase 3 — Extend the Keys/Env page for all creds
Build on `EnvPage`: add channel accounts + app-passwords alongside the existing OAuth + provider
key groups; add rotate + **test connection**. Writes through to env/OAuth backends + `credentials`
table + n8n credential API. **Exit:** every channel's creds managed from the Keys page; tests pass.

### Phase 4 — Per-channel send path
Approve→send routes back to the originating channel via n8n send flows (email SMTP/Gmail, Telegram
bot, Slack, etc.). **Exit:** approved drafts deliver on every enabled channel.

---

## Key risks / open questions

- **Native UI needs DB access.** "Native-merge" means the Hermes dashboard server queries the
  mailbox Postgres (or absorbs the mailbox-dashboard API). Decide: extend `web_server.py` (Python →
  mailbox PG) vs. keep the Next API and consume it via fetch. *Recommend: extend `web_server.py`.*
- **Credential write-through is security-critical.** Rotating OAuth tokens + app passwords + n8n
  stored credentials from the UI is the riskiest surface (encryption at rest, no secret readback,
  audit). Threat-model before building Phase 3.
- **Per-channel auth/setup is uneven.** WhatsApp Business API, Signal, SMS (Twilio) are heavier to
  provision than bot-token channels (Telegram/Discord/Slack).
- **Scale/effort.** This is multi-week. Phases 0–1 deliver the visible win (native email inbox);
  channels (Phase 2) and creds (Phase 3) are the long tail.
- **gbrain graph tab** is paused mid-seed (20 pages in mailbox2's brain) — resume after, or in
  parallel.

---

## Recommended first step
Phase 0 + Phase 1 (schema + native email inbox) — the foundation everything else hangs off, and it
retires the iframe we just shipped. Treat each phase as its own plan with exit criteria before
advancing (gate on capability, not calendar).
