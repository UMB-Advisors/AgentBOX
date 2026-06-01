# Context — Phase 4: Per-channel send path
Source PRD section: PRD §Phases ▸ Phase 4; §Target architecture (approve → n8n per-channel SEND ▸ channel); §Decisions D3 (n8n send for email, platform-adapter outbound for social) / D5 (reuse-first)
Source PRD file: unified-inbox-prd.v0.1.0.md (v0.2.0)
Roadmap: ROADMAP-v1.0.0.md (Phase 4)

This is the ship-it **discuss step** for Phase 4. It captures how an approved draft routes
back to the **originating channel + account**, and the concrete send dispatch — grounded in the
**live** mailbox code (mailbox2) and the Hermes gateway, not the PRD's mental model. The executor
needs nothing beyond **this file + the PRD**.

Phase 4 is **reuse-first wiring**, not new transports. Email send already exists end-to-end on the
live appliance (two n8n flows). Social send already exists in the Hermes gateway adapters. Phase 4's
job is the **dispatch fork**: given a draft, pick the right existing send path by channel+provider.

---

## CRITICAL: ground-truth the executor MUST honor

Read live before trusting the PRD's "approve → n8n per-channel send" diagram. The actual live code:

1. **Email send is ALREADY built and provider-routed — do NOT rebuild it.** The live approve path is
   `dashboard/app/api/drafts/[id]/approve/route.ts` → `transitionToApprovedAndSend()` in
   `dashboard/lib/transitions.ts` → `triggerSendWebhook(draftId, provider)` in `dashboard/lib/n8n.ts`.
   Two n8n send workflows already exist on mailbox2 (`/home/mailbox/mailbox/n8n/workflows/`):
   - **`MailBOX-Send`** (webhook path `mailbox-send`, env `N8N_WEBHOOK_URL`) → Gmail `reply` node →
     marks `drafts.status='sent'`, stamps `sent_gmail_message_id`.
   - **`MailBOX-Imap-Send`** (webhook path `mailbox-imap-send`, env `N8N_IMAP_WEBHOOK_URL`) →
     SMTP `emailSend` node → marks sent, stamps `provider_message_id`.
   The fork key is **`accounts.provider`** (`MAIL_PROVIDERS = ['gmail','imap','microsoft']` in
   `dashboard/lib/types.ts`), resolved by `getDraftProviderContext(draftId)` →
   `{account_id, provider}` (JOIN drafts→accounts). **`microsoft` has NO send webhook yet** — that
   gap is in-scope below.

2. **Send routing keys off `accounts.provider`, NOT `inbox_messages.channel`.** This is the single
   most important reconciliation. The PRD speaks of "channel"; the live email send fork is by
   *provider*. For email, `channel='email'` maps to one of three providers (gmail/imap/microsoft).
   For social, `channel` (telegram/discord/slack/…) IS the routing key because there's no separate
   "provider" axis. **Phase 4's dispatcher resolves on BOTH: channel first (email vs social class),
   then — within email — provider.** See the dispatch-matrix decision.

3. **Idempotency / send-lock already exists and MUST be preserved.** Both email send workflows
   CAS-acquire a lock BEFORE the network send:
   `UPDATE mailbox.drafts SET send_attempt_at = NOW() WHERE id = $1 AND status IN ('approved','edited') AND send_attempt_at IS NULL RETURNING id;`
   Zero rows returned ⇒ a prior attempt is in flight or crashed mid-send ⇒ the workflow refuses to
   re-fire. They also short-circuit on an `Already Sent?` check (`sent_gmail_message_id` /
   `provider_message_id` non-empty). **Any new (social) send path Phase 4 adds MUST replicate this
   CAS lock + already-sent guard** or it will double-send on retry. This is non-negotiable.

4. **Webhook failure does NOT roll back the status.** `transitionToApprovedAndSend` flips
   `status='approved'` first, then fires the webhook; on webhook failure it persists the cause to
   `drafts.error_message` and returns **502** but leaves the row at `approved` (operator re-fires via
   the existing `/retry` route). Status only becomes `sent` inside the n8n workflow's `Mark Sent`
   node on confirmed delivery. **Phase 4 social send must follow the same contract: `approved` →
   adapter send → on success `status='sent'`; on failure stay `approved` + populate `error_message`,
   surface the failure to the UI.** (Mirrors ROADMAP AC#2.)

5. **The send is a Gmail/SMTP REPLY, not a fresh compose.** `MailBOX-Send` uses the Gmail `reply`
   operation keyed on the source `inbox_messages.message_id`; `MailBOX-Imap-Send` builds
   `Re: <original_subject>` and threads via `original_references`. The reply target comes from the
   **source inbox message**, joined in the n8n `Load Draft` query
   (`JOIN mailbox.inbox_messages m ON d.inbox_message_id = m.id`). The social analogue is: reply to
   the originating chat using the **source message's channel addressing** — `external_id`
   (reply-to message id) + `metadata.chat_id` (the destination). See "Routing back to origin".

6. **Cooldown gate is provider-scoped and runs BEFORE the status flip.** `transitionToApprovedAndSend`
   calls `getGmailCooldown()` (gmail) or `getMailCooldown(account_id, provider)` (imap) and returns
   **429** if active, leaving the row at its source state. Social channels have no cooldown bucket
   today. **Decision:** Phase 4 does NOT invent social rate-limit buckets — the adapters' own
   `_send_with_retry` (gateway `base.py`) handles transient backoff. The cooldown gate stays
   email-only; the dispatcher skips it for social. Rationale: D5 reuse-first; don't build a
   rate-limit subsystem the adapters already cover.

**Decision (records the reconciliation):** Phase 4 is a **dispatch fork over existing send paths**,
not a new send engine. Where the PRD says "n8n per-channel send for every channel", the live truth is
**n8n for email (already done, 2 flows), platform-adapter `.send()` for social (already exists in the
gateway)** — exactly D3. The dispatcher Phase 4 adds is the only net-new logic. **This routing-axis
divergence (provider vs channel) is logged to STATE Drift watch.**

---

## Routing back to the originating channel (the core of Phase 4)

An approved draft must deliver on the **same channel AND the same account** the source arrived on
(ROADMAP AC#1). The identity needed to do that is already on the draft + its source message
(Phase 0 schema):

| Need | Source column (live, post-045) | Notes |
|------|--------------------------------|-------|
| Which channel class | `drafts.channel` (denormalized, Phase 0) | `'email'` → n8n; else → adapter outbound |
| Which account | `drafts.account_id` → `accounts` | FK exists (migration 033). Multi-account safe. |
| Email transport | `accounts.provider` (`gmail`/`imap`/`microsoft`) | The existing email fork key. |
| Social destination (chat) | `inbox_messages.metadata->>'chat_id'` (and/or `recipient`/`sender`) | The Phase 2 ingest bridge writes the platform chat id into `metadata`; the reply goes back to it. |
| Social reply-to message | `inbox_messages.external_id` | The native platform message id (Phase 0 column). Passed as `reply_to` to `adapter.send`. |
| Email reply target | `inbox_messages.message_id` / `thread_id` / `"references"` | Already consumed by the n8n `Load Draft` JOIN. Unchanged. |
| Draft body | `drafts.draft_body` (canonical; `body_text` is denorm) | Phase 0 confirmed: no separate `body` column. |

**The dispatcher resolution (single source of truth):**
```
ctx = getDraftSendContext(draftId)   // extends getDraftProviderContext
  -> { channel, account_id, provider, external_id, chat_id, draft_body, status }

if channel == 'email':
    provider == 'gmail'     -> POST N8N_WEBHOOK_URL          {draft_id}   (MailBOX-Send)
    provider == 'imap'      -> POST N8N_IMAP_WEBHOOK_URL     {draft_id}   (MailBOX-Imap-Send)
    provider == 'microsoft' -> POST N8N_MSGRAPH_SEND_URL     {draft_id}   (NEW flow — see scope)
else (social channel):
    -> route to Hermes gateway adapter for Platform(channel),
       call adapter.send(chat_id, draft_body, reply_to=external_id) -> SendResult
       then mark sent / failed (mirroring the n8n Mark Sent contract)
```

- **Decision — the dispatcher lives in `transitions.ts` / `n8n.ts`, extending what's there.** Keep
  `transitionToApprovedAndSend` as the single approve/retry funnel (the cooldown gate, the
  status-flip txn with the `mailbox.actor` GUC audit, the 502/error_message persistence all stay).
  Replace the unconditional `triggerSendWebhook(id, provider)` call with a `dispatchSend(ctx)` that
  branches email-n8n vs social-adapter. Rationale: D5 — one funnel already enforces the lock-step
  contract (audit, cooldown, error persistence); branching there reuses all of it for free.

### Social send — how the dashboard reaches the gateway adapter

The Hermes gateway holds live adapters in `gateway.delivery.DeliveryRouter.adapters:
Dict[Platform, BasePlatformAdapter]` and dispatches via
`adapter = self.adapters.get(target.platform); await adapter.send(chat_id, content, reply_to, metadata) -> SendResult`
(`gateway/delivery.py` `_deliver_to_platform`). The adapter `.send()` abstract contract
(`gateway/platforms/base.py`) is:
```python
async def send(self, chat_id: str, content: str,
               reply_to: Optional[str] = None,
               metadata: Optional[Dict[str, Any]] = None) -> SendResult
# SendResult(success: bool, message_id: Optional[str], error: Optional[str], retryable: bool, ...)
```
`Platform` enum values (`gateway/config.py`) are exactly the social `channel` strings
(`telegram`, `discord`, `slack`, `whatsapp`, `signal`, `sms`, `matrix`, …) — so
`Platform(channel)` maps a `drafts.channel` directly to the adapter. The mailbox dashboard
(Next.js/Node) does NOT share a process with the gateway (Python), so it cannot call `.send()`
in-process.

- **Decision — social send routes through one n8n outbound→gateway bridge, symmetric to the Phase 2
  inbound bridge.** The dashboard POSTs `{draft_id}` (same minimal contract as the email webhooks) to
  a single new n8n flow **`MailBOX-Social-Send`** (env `N8N_SOCIAL_SEND_URL`). That flow does the
  same `Load Draft` (CAS lock, already-sent guard, JOIN to `inbox_messages` for `external_id` +
  `metadata.chat_id` + `channel`), then HTTP-POSTs to a **new gateway outbound endpoint**
  (`POST <gateway>/api/platforms/{channel}/send` with `{chat_id, content, reply_to, account_id}`)
  which calls `adapters[Platform(channel)].send(...)` and returns the `SendResult` JSON. On
  `success`, the flow's `Mark Sent` node sets `status='sent'` + stamps the returned `message_id` into
  a channel-agnostic sent-id column. Rationale: (a) keeps the dashboard's send contract uniform
  (`POST {draft_id}` to an n8n webhook for EVERY channel — email already works this way), (b) reuses
  the n8n lock/already-sent/mark-sent machinery verbatim instead of reimplementing idempotency in
  Node, (c) the gateway already owns the live adapter sockets — a thin HTTP `send` endpoint on its
  existing aiohttp server (`gateway/platforms/api_server.py`, which already hosts `/api/...` routes)
  is the minimal seam. This is "the platform adapters' existing OUTBOUND" per the PRD, exposed over
  the one IPC hop the dashboard↔gateway split forces.
  - **Alternative considered & rejected:** dashboard calls the gateway HTTP endpoint directly (no
    n8n). Rejected because it would force re-implementing the CAS send-lock + already-sent + mark-sent
    contract in `transitions.ts` for social only, diverging from the email path. One contract
    (`POST {draft_id}` → n8n) for all channels is the smaller, safer surface.

- **Decision — `reply_to` = `inbox_messages.external_id`; `chat_id` = `metadata->>'chat_id'`.**
  The Phase 2 ingest bridge is the producer of these values; Phase 4 is the consumer. If `chat_id`
  is absent in `metadata`, fall back to `recipient`/`sender` (the agnostic-alias columns Phase 0
  backfilled). If neither resolves, the send is a hard config error → `error_message` +
  surface-to-UI, NOT a silent drop (mirrors the email path's "Respond Not Found").

---

## Decisions captured (the discuss step)

- **API shape — dashboard approve (unchanged, reused):** `POST /dashboard/api/drafts/[id]/approve`
  (loopback through the Hermes :9119 reverse-proxy; `/dashboard/*` is unauthenticated loopback).
  Body: none. Response on success: `{ success: true, draft_id, webhook_response }` (200). On cooldown:
  `{ error, message, provider, next_retry_at }` (429). On send-webhook failure:
  `{ success: false, draft_id, error }` (502) with `drafts.error_message` persisted. **Phase 4 does
  NOT change this route's external contract** — it only changes what `transitionToApprovedAndSend`
  dispatches to internally. Retry path (`POST /dashboard/api/drafts/[id]/retry`) funnels through the
  same helper and inherits the new dispatch for free.
- **API shape — n8n send webhooks (the dispatch targets):** every channel uses the identical request
  body `{ "draft_id": <int> }` and the JSON-or-empty-body response the dashboard already tolerates
  (`triggerSendWebhook` treats an empty 200 as a probable upstream send failure). Env vars:
  `N8N_WEBHOOK_URL` (gmail, existing), `N8N_IMAP_WEBHOOK_URL` (imap, existing),
  `N8N_MSGRAPH_SEND_URL` (microsoft, NEW), `N8N_SOCIAL_SEND_URL` (all social, NEW). Missing env ⇒
  `{success:false, error:'<ENV_NAME> not configured'}` (matches existing `triggerSendWebhook`).
- **API shape — gateway outbound endpoint (NEW, social only):**
  `POST <gateway-base>/api/platforms/{channel}/send`, body
  `{ chat_id: string, content: string, reply_to?: string, account_id?: int }`, returns the
  `SendResult` as JSON `{ success, message_id?, error?, retryable? }`. 404 if no live adapter for
  `Platform(channel)` (maps to the gateway's existing `_deliver_to_platform` "No adapter configured"
  ValueError). Added to the existing aiohttp router in `gateway/platforms/api_server.py`.
- **Error handling:**
  - **Send-lock loss (0 rows from CAS):** n8n flow responds "in flight / crashed mid-send"; dashboard
    surfaces it; status stays `approved`. Operator clears `send_attempt_at` to retry (existing email
    behavior — replicate for social).
  - **Adapter send failure (`SendResult.success == false`):** the social n8n flow does NOT run
    `Mark Sent`; it responds failure; `transitionToApprovedAndSend` persists `error_message`, returns
    502, row stays `approved`. If `SendResult.retryable`, the operator `/retry` is the recovery (no
    auto-retry added — the adapter's own `_send_with_retry` already did transient retries before
    returning).
  - **Gateway unreachable / 5xx:** treated like any webhook failure → 502 + error_message. The
    15 s `AbortSignal.timeout` on the dashboard fetch (existing in `n8n.ts`) bounds it.
  - **Wrong-account send (multi-account safety):** the `Load Draft` JOIN resolves
    `account_id`→addressing from the DB, never from request input, so an approved draft can only send
    on its own account. This is the same invariant `resolveIngestAccountId` enforces inbound.
- **Data structures:**
  - `DraftSendContext` (extends `DraftProviderContext`): `{ account_id, provider, channel,
    external_id, chat_id, draft_body, status }` — resolved by one `getDraftSendContext(draftId)` JOIN
    `drafts d` → `accounts a` → `inbox_messages m`, selecting `d.channel, d.account_id, d.draft_body,
    d.status, a.provider, m.external_id, m.metadata->>'chat_id' AS chat_id`.
  - **Channel-agnostic sent-id column:** the social `Mark Sent` needs somewhere to stamp the returned
    platform `message_id`. Live `drafts` already has `sent_gmail_message_id` (gmail) and
    `provider_message_id` (imap). **Decision:** social send writes the returned id to the existing
    `provider_message_id` column (already provider-neutral per migration 025's "provider-neutral"
    comment), NOT a new column. Rationale: D5 + smallest change; `provider_message_id` is exactly the
    "transport-agnostic delivered-message id" slot and the `Already Sent?` guard can read it. No
    Phase 4 migration required.
- **Edge cases:**
  - **`microsoft` provider email accounts** exist in `MAIL_PROVIDERS` and via
    `/dashboard/api/accounts/microsoft`, but have **no send webhook**. Phase 4 adds the
    `N8N_MSGRAPH_SEND_URL` fork + (optionally) the `MailBOX-Msgraph-Send` flow stub. If the flow is
    out of this milestone's appetite, the dispatcher must return a clean
    `{success:false, error:'microsoft send not configured'}` rather than mis-route to Gmail.
  - **Draft not in `approved`/`edited`:** the n8n `Load Draft` `WHERE status IN ('approved','edited')`
    returns 0 rows → "Respond Not Found". Preserve for all channels.
  - **Email reply with no source `message_id`** (e.g. a draft authored without an inbound parent):
    out of scope — Phase 4 only sends replies to ingested messages, matching the live JOIN.
  - **Channel value not in the social adapter set** (e.g. `ntfy`, which is send-only/notify): the
    gateway endpoint 404s on a missing live adapter; surface as a config error. Don't crash the
    dispatcher.
  - **`status='sent'` already** (double-approve race): the CAS lock + `Already Sent?` guard make the
    second fire a no-op; the dashboard's already-sent path returns success-ish without re-sending.

---

## Scope boundary
Files / modules this phase may touch:
- **Dashboard send dispatch (mailbox2 — REVIEW/STAGE ONLY; do NOT edit live, do NOT deploy):** the
  Phase 4 *design targets* are `dashboard/lib/transitions.ts` (branch in
  `transitionToApprovedAndSend`), `dashboard/lib/n8n.ts` (add `dispatchSend` / social + msgraph
  webhook callers), `dashboard/lib/queries-accounts.ts` (add `getDraftSendContext`). **Per the
  ground rules, this CONTEXT does NOT authorize touching mailbox2 files** — it specifies the change
  for whoever owns the mailbox repo. Phase 4 code authored *here* is the Hermes-side glue only.
- **n8n workflows (mailbox2 — STAGE as JSON under this repo, do NOT import to live):** new
  `MailBOX-Social-Send` (webhook `mailbox-social-send`) and optional `MailBOX-Msgraph-Send`. Author
  as workflow JSON into `/home/bob/code/tbox/HermesBOX/docs/unified-inbox/` artifacts for review,
  mirroring how Phase 0 staged migrations. **Do NOT import/activate on mailbox2.**
- **Hermes gateway outbound endpoint:**
  `/home/bob/code/tbox/HermesBOX/hermes-agent-main/hermes-agent-main/gateway/platforms/api_server.py`
  (+ a thin handler delegating to `DeliveryRouter`/`adapters[Platform(channel)].send`). This is the
  only genuinely-new runtime code and the one IPC seam.

Explicitly OUT of scope / DO NOT TOUCH this phase:
- Deploying anything; importing/activating n8n flows on mailbox2; editing mailbox2 files; running
  migrations (none needed — `provider_message_id` reused). `git`. Linear.
- Rebuilding email send (done). Inventing social rate-limit/cooldown buckets (adapters own retry).
- Phase 1 native React inbox/draft pages (the approve button that calls
  `/dashboard/api/drafts/[id]/approve` is wired in Phase 1; Phase 4 only changes what that approve
  *dispatches to*). The credentials/test surface (Phase 3). Ingest bridge that populates
  `external_id`/`metadata.chat_id` (Phase 2 — Phase 4 *consumes* them).

---

## Hand-off to executor
Acceptance criteria (mirrored from ROADMAP Phase 4 / PRD §Phase 4 — every criterion measurable):
- [ ] Approving a `pending`/`edited` draft delivers the reply on the **same channel AND account** the
      source message arrived on, for every **enabled** channel. (Resolution is DB-derived via
      `getDraftSendContext`: `channel`→email-vs-social, `provider`→gmail/imap/microsoft,
      `account_id`→addressing — never from request input.)
- [ ] On confirmed delivery the draft's `status` is set to `sent` (by the n8n `Mark Sent` node, on a
      truthy `SendResult.success` for social / a returned message id for email); on send failure the
      status is **NOT** set to `sent`, the row stays `approved`, `drafts.error_message` carries the
      cause, and the failure is surfaced to the UI (502 from the approve/retry route).
- [ ] **Email** approve→send delivers via the existing n8n email flow — gmail via `MailBOX-Send`
      (`N8N_WEBHOOK_URL`), imap via `MailBOX-Imap-Send` (`N8N_IMAP_WEBHOOK_URL`) — selected by
      `accounts.provider`, with the CAS send-lock + `Already Sent?` guard intact.
- [ ] **At least one social channel** approve→send delivers via the reused platform-adapter outbound:
      dashboard `POST {draft_id}` → `MailBOX-Social-Send` (`N8N_SOCIAL_SEND_URL`) → gateway
      `POST /api/platforms/{channel}/send` → `adapters[Platform(channel)].send(chat_id, draft_body,
      reply_to=external_id)` → `SendResult.success` → `Mark Sent` (stamps `provider_message_id`).
- [ ] **Idempotency preserved:** a second approve/retry of an already-sent or in-flight draft does NOT
      double-send (CAS lock returns 0 rows / `Already Sent?` short-circuits) on **every** channel,
      including the new social path.
- [ ] **No new migration:** the social path reuses `provider_message_id` for the delivered-message id;
      `drafts.status` machine (`pending→approved→sent`, `approved` on failure) is unchanged.

### Notes for the executor
- You need **nothing beyond this file + the PRD**. Exact live shapes are reproduced above from
  mailbox2 (`dashboard/lib/{transitions,n8n,queries-accounts,types}.ts`, the two `MailBOX-*Send.json`
  workflows) and the Hermes gateway (`gateway/platforms/base.py` `send`/`SendResult`,
  `gateway/delivery.py` adapter dispatch, `gateway/config.py` `Platform` enum).
- **Biggest trap:** send routes on `accounts.provider` for email and on `drafts.channel` for social —
  do NOT assume one axis. Resolve both in `getDraftSendContext`.
- **Biggest invariant to preserve:** the CAS send-lock (`send_attempt_at` set iff NULL) + `Already
  Sent?` guard. Replicate them in `MailBOX-Social-Send` exactly, or social sends double-fire on retry.
- **One contract for all channels:** the dashboard always sends `POST { draft_id }` to an n8n webhook;
  the per-channel divergence lives inside n8n, not in `transitions.ts`. Keep it that way.
