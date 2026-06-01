# Context — Phase 2: Channels via the hybrid pipeline (iterative)
Source PRD section: unified-inbox-prd.v0.1.0.md (v0.2.0) — §Decisions D3/D5, §Components 2 (Ingestion hybrid), §Phases ▸ Phase 2; ROADMAP-v1.0.0.md ▸ Phase 2.

> **D3 (locked):** Hybrid, n8n normalizes. Hermes `platforms` adapters RECEIVE social inbound → a thin **forward-to-n8n bridge** POSTs to **one** n8n **ingest webhook** → n8n normalizes (set `channel`/`external_id`/`metadata`/`account_id`) → writes `mailbox.inbox_messages` → **reuses the existing email flow's classify + draft sub-steps**. Email keeps entering n8n directly (unchanged). **D5:** EXTEND existing Hermes/mailbox features; new code is *the bridge + the generalized normalize+ingest step*, **not ~10 channel integrations.**

This file is self-contained: an executor needs only this file + the PRD. All schema/API/flow facts below were read from the **LIVE** system (mailbox2, migration 045) and the **CURRENT** Hermes workstation checkout, not the stale `/home/bob/mailbox` (035) tree.

---

## 0. Ground-truth seams discovered (read these before deciding anything)

**The reuse seam is already built and channel-agnostic.** The live email pipeline is:

```
MailBOX (poll) ─▶ Extract Fields ─▶ POST /dashboard/api/internal/inbox-messages
                  (dashboard is the SINGLE writer of mailbox.inbox_messages; STAQPRO-135)
                       │ returns { id:number, message_id:string, created:boolean }
                       ▼
                  IF created==true ─▶ executeWorkflow "MailBOX-Classify" (id=MlbxClsfySub0001), passthrough { id }
                       │
        MailBOX-Classify:  Load Inbox Row (SELECT … WHERE id=$1)
                           ─▶ Build Prompt  (POST /internal/classification-prompt { from, subject, body })
                           ─▶ Call Ollama ─▶ Normalize (POST /internal/classification-normalize { raw, from, to })
                           ─▶ Insert Classification Log
                           ─▶ IF not spam ─▶ Live Gate (GET /internal/onboarding/live-gate)
                           ─▶ IF live ─▶ Insert Draft Stub (status pending) ─▶ Pack Draft Id { draft_id }
                           ─▶ executeWorkflow "MailBOX-Draft" (id=MlbxDraftSub0001, mode=each)
        MailBOX-Draft:     Get Prompt ─▶ Call LLM ─▶ POST /internal/draft-finalize
```

Three facts make this directly reusable for any channel — **do not rebuild classify/draft:**
1. **`MailBOX-Classify` keys off `inbox_messages.id` only.** `Load Inbox Row` = `SELECT … WHERE id = $1`; `When Called by Main` is `inputSource: passthrough` expecting `{ id }`. Channel-neutral.
2. **`Build Prompt` uses only `from_addr` / `subject` / `body || snippet`.** No email-only field is load-bearing. A social message that fills `from_addr` (sender handle) + `body` classifies + drafts unchanged.
3. **`classification-normalize` consumes `from`/`to` for the operator-domain preclass (DR-50) + thread-owner guard (UMB-154).** On social these simply won't match an operator email domain → the message drafts normally (graceful degradation, no special-casing needed).

**The schema is already channel-ready (migration 045, Phase 0 applied).** Verified live on mailbox2:
- `mailbox.inbox_messages`: `channel text NOT NULL DEFAULT 'email'`, `external_id text NULL`, `metadata jsonb NOT NULL DEFAULT '{}'`, `account_id int NOT NULL DEFAULT 1`. Indexes: `idx_inbox_messages_channel`, `idx_inbox_messages_channel_external (channel, external_id)`. **UNIQUE dedup is `(account_id, message_id)`** (`inbox_messages_account_message_uq`) — *not* on `external_id`.
- `mailbox.drafts`: `channel text NOT NULL DEFAULT 'email'`, `account_id int NOT NULL DEFAULT 1`. `drafts.status` machine = **`pending | awaiting_cloud | approved | rejected | edited | sent`** (live CHECK). Two `AFTER UPDATE OF status` triggers fire (`archive_draft_to_sent_history`, `log_draft_state_transition`) — status transitions are observed for free.
- `mailbox.accounts`: `channel text NOT NULL DEFAULT 'email'` with a CHECK that **already enumerates every target channel** (`email, telegram, discord, slack, whatsapp, signal, sms, teams, matrix, mattermost, irc, line, google_chat, ntfy, simplex`). `enabled bool`, `is_default bool` (partial-unique `accounts_one_default`), `email_address text UNIQUE NOT NULL`. **3 email accounts already exist** (ids 1/2/3: `primary@appliance.local` default, `consultingfutures@gmail.com`, `dustin@heronlabsinc.com`) → multi-account email (wave a) is data-ready.
- **BLOCKER for social accounts:** `accounts_provider_check` CHECK allows **only `gmail | imap | microsoft`**, and `email_address` is `NOT NULL UNIQUE`. A social account row therefore needs a provider value the CHECK permits and a unique `email_address`. See Decision §1 "Account model for social."

**The Hermes receive seam is `adapter.set_message_handler(handler)`** (CURRENT checkout `gateway/platforms/base.py:1931`; wired in `gateway/run.py:4247,5955` to `_handle_message`). Every adapter calls `await self._message_handler(event)` (base.py:3423/3541/3591/3738) with a normalized **`MessageEvent`** (base.py:1286). `MessageEvent` fields available to the bridge: `text`, `message_type`, `source: SessionSource`, `message_id`, `media_urls/media_types`, `reply_to_message_id`, `reply_to_text`, `timestamp`. `SessionSource` (`gateway/session.py:71`) carries: `platform: Platform`, `chat_id`, `chat_name`, `chat_type` (dm/group/channel/thread), `user_id`, `user_name`, `thread_id`, `guild_id` (Discord guild / Slack workspace / Matrix server), `user_id_alt` (Signal UUID / Feishu union_id), `message_id`. The handler returns `Optional[str]` (a reply) — **the bridge returns `None`** (triage mode: no synchronous auto-reply; the draft/approve loop owns the response). This is the entire net-new RECEIVE surface.

**Reachability:** the dashboard REST + internal routes are reached at `http://127.0.0.1:3001/dashboard/api/...` (Next.js `basePath=/dashboard`); n8n nodes call `http://mailbox-dashboard:3001/dashboard/api/internal/...` over the compose network. The Hermes side reaches the mailbox dashboard through the existing Hermes reverse-proxy on `:9119` at `/dashboard/*` (un-auth loopback; `/dashboard/*` does **not** carry the `X-Hermes-Session-Token`).

---

## Decisions captured (the discuss step)

- **Ingest topology — ONE webhook, n8n is the single normalize point (D3).** Net-new n8n flow `MailBOX-Ingest` exposing a single `n8n-nodes-base.webhook` (POST, path `mailbox-ingest`). It normalizes the bridge payload → POSTs the **existing** `/dashboard/api/internal/inbox-messages` writer → on `created==true`, `executeWorkflow "MailBOX-Classify"` with `{ id }`. **Rationale:** the dashboard is the locked single writer of `inbox_messages` (STAQPRO-135); routing through it means the social path inherits dedup, account resolution, and (where applicable) RAG for free, and reuses classify/draft verbatim — exactly D5. Email keeps its own poll flow untouched.

- **Bridge owns "social → ingest payload" mapping; n8n owns "payload → DB columns."** The Hermes bridge converts a `MessageEvent` into a flat JSON envelope (below) and POSTs it to the webhook. The bridge does NOT talk to Postgres or to the internal endpoint directly — it only knows the webhook URL. **Rationale:** keeps Hermes free of mailbox schema knowledge (decoupling); n8n remains the normalize authority per D3; one place (the webhook) to evolve column mapping.

- **The internal `inbox-messages` writer must gain channel awareness — minimal extension, not a new endpoint.** Today `inboxMessageInsertBodySchema` (live `dashboard/lib/schemas/internal.ts`) has **no** `channel`/`external_id`/`metadata` fields and `resolveIngestAccountId` resolves only by `account_id`/`account_email`. The executor extends the schema + route to accept optional `channel` (default `'email'`), `external_id`, `metadata`, and to resolve the account by `account_id` directly (social accounts have no email). It must **skip the email-only RAG embed** (`embedAndUpsertInbound`) when `channel != 'email'`. **Rationale:** the writer is the single insert point; one additive change there serves every channel and preserves the locked Gmail path (all new fields optional, default to today's behavior). *Boundary note: the route file lives on mailbox2 — see Scope boundary; this CONTEXT specifies the contract, the executor that owns the mailbox repo implements it.*

- **`message_id` for social = the channel-native id; `external_id` = same value, mirrored for indexed lookup.** Dedup uniqueness is `(account_id, message_id)`, so the channel message id MUST land in `message_id` to get idempotent ingest. Also write it to `external_id` so `(channel, external_id)` lookups (reply correlation, send-path) work. **Rationale:** reuses the existing dedup machinery (xmax=0 `created` trick) with zero schema change; `external_id` is the queryable handle for Phase 4 send routing.

- **`metadata jsonb` carries the channel-routing identity needed to reply.** The bridge packs into `metadata`: `chat_id`, `thread_id`, `user_id`, `user_id_alt`, `guild_id`, `chat_type`, `user_name`, `reply_to_message_id`, and `platform`. **Rationale:** Phase 4 send must reply to the exact chat/thread/user on the exact account; `inbox_messages` has no per-channel address columns, so `metadata` is the contract for round-tripping routing context. Capturing it now (Phase 2) avoids a re-ingest later.

- **Account model for social (resolves the provider-CHECK blocker).** One `accounts` row per connected social identity (e.g. the bot/workspace), created during onboarding with `channel=<channel>`, `enabled=true`. Because `accounts_provider_check` forbids social provider strings and `email_address` is `NOT NULL UNIQUE`, the **recommended** resolution (lowest blast radius, decided here): set `provider='imap'` as an inert placeholder and `email_address` to a synthetic unique URI `"<channel>:<identity>"` (e.g. `telegram:@heronbot`, `slack:T0123`), with the human label in `display_label`. The bridge/webhook then resolves `account_id` by that synthetic `email_address` (existing `resolveIngestAccountId` by `account_email`) **or** by explicit `account_id`. *Alternative, flagged for the executor with mailbox-repo authority:* a one-line migration broadening `accounts_provider_check` to include `'social'` (or per-channel values) is cleaner long-term but is a schema change — out of this phase's Hermes-only scope, so the synthetic-URI path is the default. **This is the load-bearing gray area; surfaced in Notes.**

- **Onboarding order (waves, gated independently per ROADMAP).**
  1. **(a) Multi-account email** — n8n direct, no bridge. Lowest risk: accounts 2 & 3 already exist; the multi-account fan-out passes `account_id`/`account_email` to the writer (live `MBOX-348` path already supports it). Proves the unified inbox renders ≥2 `account_id`s. *Why first:* zero new RECEIVE code; validates the inbox/filter end of Phase 1 against >1 account before any social risk.
  2. **(b) Telegram / Discord / Slack** — bot-token channels, adapters already mature in `gateway/platforms`. First real exercise of the bridge → webhook → classify/draft path. *Why second:* cheapest auth (bot tokens), highest-fidelity adapters, immediate visible win.
  3. **(c) WhatsApp / Signal / SMS** — heavier provisioning (WhatsApp Business API, Signal CLI/registration, Twilio for SMS) per PRD risk. *Why third:* same bridge, but onboarding/credential cost dominates; do after the bridge is proven on bot channels.
  4. **(d) Teams / Matrix / others** — webhook/HTTP-callback adapters (`msgraph_webhook`, `matrix`) + the remaining plugin platforms. *Why last:* most setup variance; value per-channel is lower; bridge is identical so it's mechanical onboarding.

- **API shape — the bridge → n8n ingest envelope (flat JSON, POST):**
  ```json
  {
    "channel": "telegram",
    "external_id": "<MessageEvent.message_id>",
    "account_ref": "telegram:@heronbot",
    "sender": "<source.user_name or source.user_id>",
    "sender_id": "<source.user_id>",
    "recipient": "<account display identity>",
    "thread_ref": "<source.thread_id or source.chat_id>",
    "subject": null,
    "body": "<MessageEvent.text>",
    "received_at": "<MessageEvent.timestamp ISO8601>",
    "metadata": {
      "platform": "telegram",
      "chat_id": "<source.chat_id>",
      "chat_type": "<source.chat_type>",
      "thread_id": "<source.thread_id>",
      "user_id": "<source.user_id>",
      "user_id_alt": "<source.user_id_alt>",
      "guild_id": "<source.guild_id>",
      "user_name": "<source.user_name>",
      "reply_to_message_id": "<MessageEvent.reply_to_message_id>"
    }
  }
  ```
  The n8n webhook maps this to the internal writer body: `message_id ← external_id`, `external_id ← external_id`, `channel`, `account_email ← account_ref` (or `account_id`), `from_addr ← sender`, `to_addr ← recipient`, `subject ← subject` (null OK; `subject` is nullable email-only), `thread_id ← thread_ref`, `body`, `snippet ← body[:200]`, `received_at`, `metadata`. Writer returns `{ id, message_id, created }`; on `created` → classify sub `{ id }`.

- **API shape — extended `inboxMessageInsertBodySchema` (additive only):** add `channel: z.enum(CHANNELS).optional().default('email')`, `external_id: z.string().optional()`, `metadata: z.record(z.unknown()).optional().default({})`. Insert them into the `.values({...})`. Guard the RAG embed with `if (row.created && channel === 'email')`. Everything else unchanged — the locked Gmail contract and response shape `{ id, message_id, created }` are preserved.

- **Error handling.**
  - **Webhook bridge POST:** bridge uses a short timeout (5s, matching n8n's existing `httpRequest` timeouts) and **fire-and-forget with bounded retry (1 retry)**; a webhook failure must NOT block or crash the Hermes adapter's receive loop (mirrors the dashboard's "RAG failure is augmentation not gate" pattern). Log + drop on final failure; the message is lost-to-triage but the conversational path (if also wired) is unaffected.
  - **Unknown/disabled account:** writer returns **400** on unresolved account (live `resolveIngestAccountId` already does this — "fail loud rather than mis-file"). The webhook surfaces 400 as a failed execution (visible in n8n); the bridge logs it. Onboarding a channel = create its `accounts` row first.
  - **Dedup:** re-delivered channel messages (adapter re-connect, at-least-once webhooks) collide on `(account_id, message_id)` → `created==false` → classify is **skipped** (the `IF created` gate). Idempotent by construction; no duplicate drafts.
  - **Missing `body`:** social events with only media (`text==''`) — bridge still POSTs (so the message is visible); classify's `Build Prompt` falls back to `body || snippet` → may classify as low-signal. Acceptable; do not drop.
  - **Spam / not-live:** existing `Drop Spam?` and `Live Gate` branches in `MailBOX-Classify` apply uniformly — social spam is dropped and onboarding gating is inherited for free.

- **Data structures.** Reused as-is: `MessageEvent`, `SessionSource` (Hermes); `mailbox.inbox_messages`, `mailbox.drafts`, `mailbox.accounts` (live schema, no migration in this phase). Net-new: the bridge envelope (above) and the `MailBOX-Ingest` n8n workflow JSON. The `metadata jsonb` shape above is the de-facto contract Phase 4 send reads back.

- **Edge cases.**
  - **Same Gmail/social message into two connected accounts** is legitimate and de-duped per-account (unique is `(account_id, message_id)`), so it correctly appears once per inbox.
  - **Group/channel messages** (chat_type group/channel) ingest like DMs; `thread_ref` distinguishes threads. The unified inbox per-channel filter (Phase 1 scaffold) filters on `channel` — verify it returns only matching rows (ROADMAP AC).
  - **Bridge dual-purpose:** if a channel is ALSO wired to the conversational agent, the bridge handler must coexist with `_handle_message`. Decision: Phase 2 routes triage-channels' `set_message_handler` to the bridge (returns `None`); do NOT also run the agent on the same adapter unless explicitly configured (avoids double-processing). This is a wiring choice in `gateway/run.py`, kept minimal.
  - **`received_at` blank** → writer already coerces `''`→omit (NULL) (live guard); bridge sends ISO timestamp so normally non-null.
  - **Account `is_default` collision:** social accounts must be created with `is_default=false` (partial-unique `accounts_one_default` allows exactly one default — the email primary).

---

## Scope boundary
Files / modules this phase may touch. **Phase 1's drafts-only constraint does NOT apply to Phase 2** — this phase's net-new code is the Hermes bridge + n8n flow; the mailbox-side writer extension is specified here as a contract for whoever owns the mailbox repo.

**Hermes (workstation, this executor edits):**
- `gateway/platforms/` — net-new thin bridge module (e.g. `gateway/platforms/ingest_bridge.py`): a `MessageHandler` that builds the envelope from a `MessageEvent` and POSTs to the n8n ingest webhook. **No edits to individual adapter `.py` files** (reuse-first: the bridge attaches via `set_message_handler`).
- `gateway/run.py` — minimal wiring only: route the configured triage channels' adapters to the bridge handler (the existing `adapter.set_message_handler(...)` call sites at ~4247/5955). Smallest correct change; no refactor.
- Config surface for the webhook URL + the set of triage channels (env var, e.g. `N8N_INGEST_WEBHOOK_URL`, mirroring the existing `N8N_IMAP_WEBHOOK_URL` pattern).
- tsconfig strict (`noUnusedLocals/noUnusedParameters`) applies to any web/TS touched (none expected this phase).

**n8n (workflow JSON — do NOT deploy/import here; deliver the JSON artifact):**
- New `MailBOX-Ingest.json` (webhook → map → POST internal writer → IF created → executeWorkflow MailBOX-Classify). Mirror node style of the live `MailBOX.json`/`MailBOX-Classify.json`.

**Mailbox (mailbox2 repo — OUT of this Hermes executor's write scope; specified as a contract, implemented by the mailbox-repo owner):**
- `dashboard/lib/schemas/internal.ts` — additive fields on `inboxMessageInsertBodySchema`.
- `dashboard/app/api/internal/inbox-messages/route.ts` — insert `channel/external_id/metadata`; gate RAG embed on `channel==='email'`; resolve account by `account_id`/`account_ref`.

**Explicitly out of scope (do NOT touch):** mailbox2 files (read-only here), any migration (schema is already channel-ready at 045), git operations, deploys, the per-channel SEND path (Phase 4), the Keys/Env credential UI (Phase 3), Phase 1's native inbox React pages.

---

## Hand-off to executor
Acceptance criteria (mirrored from ROADMAP-v1.0.0.md ▸ Phase 2):
- [ ] The n8n ingest webhook accepts a normalized payload and writes a `channel`-tagged row to `mailbox.inbox_messages` **plus** a `drafts` row, for at least one non-email channel.
- [ ] **Per onboarded wave:** an inbound message on that channel appears in the native unified inbox with a generated draft, and approve→send delivers a reply back on that same channel. *(Send-back is Phase 4 — for Phase 2, "appears in the native inbox with a draft" is the per-wave gate; the send-back leg is validated jointly with Phase 4 per the dependency in ROADMAP.)*
- [ ] **Multi-account email (wave a):** messages from ≥2 distinct connected email accounts appear as separate `account_id`s in the unified inbox.
- [ ] The unified inbox per-channel filter returns only rows matching the selected `channel`.

Execution path: **dynamic-workflow** (repeating fan-out across channel adapters + long-running iterative wave onboarding, checkpointed; each wave gates on its own AC, not calendar). Surface the token-cost premium before kickoff per Operating Rule 4.
