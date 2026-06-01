# Context — Phase 1: Native inbox (replace the iframe), email-only
Source PRD: unified-inbox-prd.v0.1.0.md (v0.2.0, 2026-06-01) — §"Phases ▸ Phase 1", §"Components 3–4", §"Key risks (Native UI needs DB access)"
Roadmap: ROADMAP-v1.0.0.md — Phase 1
Ground truth verified live on **mailbox2** (migration 045, Phase 0 applied) on 2026-06-01.

> This file is self-contained. An executor needs only this file + the PRD. All API shapes below were captured by `curl`-ing the live mailbox-dashboard API on mailbox2; all schema facts are from the live `mailbox` Postgres and the live route handlers under `/home/mailbox/mailbox/dashboard/app/api/`. Do NOT trust `/home/bob/mailbox` (stale, migration 035).

---

## Decisions captured (the discuss step)

### D-1 (load-bearing, supersedes PRD): Reuse the existing mailbox-dashboard REST API; do NOT build a new DB layer in `web_server.py`.
The PRD §"Key risks" and ROADMAP Phase 1 deliverables say "extend `web_server.py` (Python → mailbox PG)" with new `/api/inbox/*`, `/api/drafts/*`, `/api/accounts/*` endpoints. **That line is superseded by D5 (reuse-first).** Rationale:
- The mailbox-dashboard (Next.js, basePath `/dashboard`) **already exposes a complete, battle-tested REST API** over the mailbox Postgres at `/dashboard/api/*`: list/get drafts (joined with their inbox message + account + thread history), approve/reject/edit/retry, and inbox-message archive/delete/mark-read/snooze. It already encodes the draft status machine, the MBOX-369 active-queue predicate, Gmail write-through, send-CAS locking, urgency, and feedback capture. Re-implementing any of that in Python would be a from-scratch rebuild of ~400 lines of `lib/queries.ts` + `lib/transitions.ts` + `lib/inbox-actions.ts` and would fork the status machine — a direct D5 violation and a correctness risk on the live email pipeline.
- The Hermes dashboard server **already reverse-proxies `/dashboard/{path}`** to the on-box mailbox-dashboard (:3001) — the same proxy the current iframe rides on (`web_server.py` `/dashboard/{path}` handler; confirmed by the `InboxPage.tsx` comment). So the browser can reach `/dashboard/api/*` **same-origin** today, no new server code.
- **Net Phase-1 server change in `web_server.py`: zero.** All Phase-1 work is in `web/src` (React) + `web/src/lib/api.ts`. This is the smallest correct change.
- The PRD's own §"Components 3" hedges this exact choice ("extend `web_server.py` … *vs.* keep the Next API and consume it via fetch"). We pick the reuse path and record it here as the resolved decision. Phases 3 (credentials) may still add Python endpoints; Phase 1 does not.

### D-2: Auth header — `/dashboard/api/*` is unauthenticated loopback; the X-Hermes-Session-Token is harmless.
`fetchJSON` (web/src/lib/api.ts) injects `X-Hermes-Session-Token` on **every** request when a token exists, and the Hermes auth middleware gates **only `/api/*`** (not `/dashboard/*`). The mailbox API ignores unknown headers. So new `api.*` methods can call through the existing `fetchJSON` with a `/dashboard/api/...` URL **unchanged** — the header rides along and is ignored; `credentials: "include"` is also harmless. Do NOT write a parallel fetch helper. (`HERMES_BASE_PATH` is prepended by `fetchJSON`; under the current reverse-proxy deployment `HERMES_BASE_PATH` is empty so `/dashboard/api/...` resolves correctly. If a box ever sets a base path, the proxy lives under it too, so prepending is correct.)

### D-3: There is NO `GET /api/inbox-messages` list endpoint. The inbox list IS `GET /dashboard/api/drafts`.
Confirmed live: `GET /dashboard/api/inbox-messages` (plural, no id) **404s**. The only list surface is `GET /dashboard/api/drafts?status=...`, which `INNER JOIN`s `inbox_messages` and `accounts` and returns a flattened row carrying both the draft and its message. **Design consequence:** the Phase-1 "Incoming Messages" list is a list of **drafts-with-their-message** (every queue row has a draft — that is the MailBOX model). The per-message inbox actions (archive/snooze/mark-read) are keyed by the **inbox_message id** (`row.inbox_message_id` / `row.message.id`), NOT the draft id. The draft actions (approve/reject/edit) are keyed by the **draft id** (`row.id`). The detail page must hold both ids.

### D-4: Master–detail in ONE page via in-component state, not a `:param` route.
`App.tsx` `buildRoutes` maps exact path strings to a component (`<Route path={path} element={<Component/>}/>`); it has no param-route plumbing. To avoid touching `buildRoutes`, Phase 1 keeps a single `/inbox` route and renders **master (list) + detail (selected message/draft)** inside `InboxPage` using local state (`selectedDraftId`), mirroring how other built-in pages (e.g. SessionsPage) own their internal selection. No new route entry, no nav change beyond what already exists. (If a deep-linkable detail URL is wanted later, add a `/inbox/:draftId` builtin entry — explicitly **out of scope** for Phase 1.)

### D-5: Channel column/filter is scaffolded from the real `channel` field, defaulted to email.
Post-045 every `inbox_messages`/`drafts` row has a `channel` column (default `'email'`); the live draft rows already return `"channel":"email"` and an `account` object. Phase 1 renders a **Channel column** (value from `row.channel`) and a **channel filter control** in the list header. Because Phase 1 is email-only, the filter's options are derived from the distinct `channel` values present in the returned rows (today: just `email`); the control is inert/single-option until Phase 2 adds channels. This satisfies the ROADMAP "per-channel filter scaffold" deliverable without faking data. The **account filter** is real now: `GET /dashboard/api/drafts?account=<id>` narrows by `account_id`, and `GET /dashboard/api/accounts` returns the 3 connected inboxes (see shapes) — wire an account selector using the existing `account` query param.

### D-6: Status tabs use the documented status machine.
The list defaults to `status=pending` (server default). The page exposes status tabs that map to the `status` CSV query param. Valid statuses (from live zod `DRAFT_STATUSES`, anchored to migration constraints): `pending`, `edited`, `approved`, `sent`, `rejected`. The "needs action" inbox view = `status=pending,edited`. Sent/rejected are secondary tabs. (`edited` is a real status: editing a draft flips it pending→edited; approve accepts both `pending` and `edited`.)

### API shape — exact, captured live (do not guess)

**`GET /dashboard/api/drafts?status=<csv>&limit=<n>&account=<id>`** → `200`
```jsonc
{ "drafts": [ DraftRow, ... ], "total": <number> }
```
`DraftRow` (flattened draft + joined message + account + thread; verified key list):
```
id, inbox_message_id, draft_subject (null for email reply), draft_body,
model, input_tokens, output_tokens, cost_usd, status, created_at, updated_at,
error_message, approved_at, sent_at, draft_source, classification_category,
classification_confidence, rag_context_refs, auto_send_blocked,
from_addr, to_addr, subject, body_text, received_at, message_id, thread_id,
in_reply_to, references, original_draft_body, rag_retrieval_reason,
kb_context_refs, last_retry_at, exemplar_refs, sent_gmail_message_id,
send_attempt_at, action_items, scheduling_calendar_unavailable, account_id,
provider_message_id, channel,
message: { id, message_id, thread_id, from_addr, to_addr, subject,
           received_at, snippet, body, classification, confidence,
           classified_at, model, created_at, draft_id, archived_at,
           deleted_at, snooze_until, is_read, gmail_action_state },
account: { id, email_address, display_label },   // NOTE: only on the list endpoint
thread_history: [ ... ]                            // prior messages in the thread
```
- Query params (live zod): `status` = CSV of valid statuses (default `pending`; **invalid status → 400**); `limit` = int 1..250 (default 50, hard-capped 200 server-side); `account` = positive int (garbage/empty/"all" → all accounts, never 400s); `urgent=1` switches to the urgency-enriched query (not needed Phase 1).
- The list applies the MBOX-369 **active-queue predicate**: archived/trashed rows are hidden; snoozed rows hidden until `snooze_until`; read rows stay visible. So "archive/snooze" naturally remove rows from the list on next refetch.

**`GET /dashboard/api/drafts/[id]`** → `200` single draft, same shape as a `DraftRow` **minus** the top-level `account` object (the detail query joins only `inbox_messages`, not `accounts`); includes `message` + `thread_history`. `404 {"error":"Not found"}` if absent. (For Phase 1 the list already carries everything; calling the detail endpoint on select is optional but recommended for a fresh read.)

**`POST /dashboard/api/drafts/[id]/approve`** (no body) → on success transitions `pending|edited → approved` and triggers send; on failure leaves row `approved` with `error_message` set. Returns the transition result JSON from `transitionToApprovedAndSend`. `409` if the draft is not in `pending|edited`.

**`POST /dashboard/api/drafts/[id]/reject`** body `{ "reason_code": <enum>, "free_text"?: string }`
- `reason_code` is **required** (enum = live `REJECT_REASON_CODES`; `free_text` required iff `reason_code === "other"`, max 2000 chars).
- Success → `{ "success": true, "draft": { id, status:"rejected" } }`; writes one `draft_feedback` row in the same txn. `409 {"error":"Draft not in pending or edited state"}`. `400` on bad body.
- **Executor action:** fetch the live enum before building the reject UI — `ssh mailbox2 'grep -n "REJECT_REASON_CODES" /home/mailbox/mailbox/dashboard/lib/types.ts'`. A minimal Phase-1 UI may hardcode a small reason set **only if** it matches that enum exactly; otherwise render a free-text + a default reason_code.

**`POST /dashboard/api/drafts/[id]/edit`** body `{ "draft_body": string (1..10000), "draft_subject"?: string|null }`
- Success → `{ "success": true, "draft": { id, status:"edited", draft_body, draft_subject, updated_at } }`. Flips status to `edited`, snapshots `original_draft_body` on first edit. `409` if not `pending|edited`. `400` on empty/oversize body.

**Inbox-message actions (keyed by `inbox_message_id`, i.e. `row.message.id` — NOT the draft id):**
- `POST /dashboard/api/inbox-messages/[id]/archive` (no body) → hides locally + Gmail removeLabel INBOX; **keeps** the pending draft. Returns the write-through result.
- `POST /dashboard/api/inbox-messages/[id]/mark-read` (no body) → clears unread; row stays in queue.
- `POST /dashboard/api/inbox-messages/[id]/snooze` body `{ "until": <ISO-8601 with offset/Z, must be future> }` → `{ "success": true, id, snooze_until }`; `404` if message not found; `400` if `until` not future / no offset. Compute `until` client-side from a preset (e.g. `new Date(Date.now()+3600e3).toISOString()`).
- `POST /dashboard/api/inbox-messages/[id]/delete` (no body) → discards row **and** its draft. (Optional for Phase 1; archive is the safer default.)

**`GET /dashboard/api/accounts`** → `200`
```jsonc
{ "accounts": [ { "id": 1, "email_address": "...", "display_label": "...|null", "is_default": true }, ... ] }
```
Live data: 3 accounts (ids 1/2/3). Use for the account-filter selector; pass the chosen `id` as `?account=<id>` to `GET /drafts`. `?detail=1` returns richer rows (provider, created_at) — not needed Phase 1.

### `api.ts` integration (exact pattern)
Add a small block of methods to the existing `api` object in `web/src/lib/api.ts`, each calling `fetchJSON<T>("/dashboard/api/...", init)` — **reuse `fetchJSON` unchanged** (D-2). Mirror the existing method style (URL-encode ids, set `Content-Type: application/json` + `JSON.stringify(body)` on POSTs). Suggested additions and their return types:
```
api.inboxListDrafts(status="pending", limit=50, accountId?) → { drafts: DraftRow[]; total: number }
api.inboxGetDraft(id)                                       → DraftRow
api.inboxApproveDraft(id)                                   → ApproveResult           // POST, no body
api.inboxRejectDraft(id, { reason_code, free_text? })       → { success; draft }       // POST json
api.inboxEditDraft(id, { draft_body, draft_subject? })      → { success; draft }       // POST json
api.inboxArchiveMessage(messageId)                          → WriteThroughResult       // POST, no body
api.inboxMarkReadMessage(messageId)                         → WriteThroughResult       // POST, no body
api.inboxSnoozeMessage(messageId, isoUntil)                 → { success; id; snooze_until }
api.inboxListAccounts()                                     → { accounts: AccountRow[] }
```
Define matching exported TS interfaces (`DraftRow`, `InboxMessage`, `AccountRow`, the action results) in `api.ts` alongside the existing ones. **tsconfig is strict (`noUnusedLocals`/`noUnusedParameters`)** — every declared interface/import must be used. Field types: numeric ids are `number`; timestamps are ISO `string`; `cost_usd` is a `string`; `classification_confidence` is `number|null`; jsonb arrays (`rag_context_refs`, `action_items`, etc.) — type as `unknown[]` unless rendered.

### Swapping `InboxPage.tsx` from iframe → native (exact)
Current `InboxPage.tsx` renders a single `<iframe src="/dashboard/queue">`. Replace its body with a native master–detail (D-4):
- **List (master):** calls `api.inboxListDrafts(status, limit, accountId)` on mount + on filter/tab change. Renders a table/list of rows with columns: unread dot (`row.message.is_read`), Channel (`row.channel`), Account (`row.account.display_label || row.account.email_address`), From (`row.from_addr`), Subject (`row.subject` or `(no subject)`), Classification (`row.classification_category`), Received (`row.received_at`), Status (`row.status`). Header holds: status tabs (D-6), a **Channel filter** (D-5, scaffold), an **Account selector** (from `api.inboxListAccounts()`), and a refresh.
- **Detail:** on row click, set `selectedDraftId`; show the source message (`row.body_text`/`row.message.body` + `thread_history`) and the editable draft (`row.draft_body`). Actions: **Edit** (textarea → `api.inboxEditDraft`), **Approve** (`api.inboxApproveDraft`), **Reject** (reason UI → `api.inboxRejectDraft`), and message actions **Archive**/**Mark read**/**Snooze** (using `row.inbox_message_id`). After any mutating action, refetch the list (the active-queue predicate + status change update visibility) and reconcile the detail.
- Keep `usePageHeader().setTitle("Incoming Messages")` (already present). Reuse `components/Card` for the panels to match dashboard styling. Remove the `__AGENTBOX_INBOX_URL__` window override and the iframe entirely.
- **Nav/route:** no change needed — `/inbox` already maps to `InboxPage` in `BUILTIN_ROUTES_CORE` and is in `buildPrimaryNav` as "Incoming Messages". Do not add a route.
- **Iframe teardown:** delete the iframe markup and `INBOX_URL`/`__AGENTBOX_INBOX_URL__`. The acceptance criterion "iframe gone" is satisfied when no `<iframe>` referencing `/dashboard/queue` remains and `grep -rn "/dashboard/queue\|__AGENTBOX_INBOX_URL__" web/src` returns nothing. The `/dashboard/{path}` **reverse-proxy in `web_server.py` stays** — the new native page still uses it for `/dashboard/api/*`. (The PRD/ROADMAP "remove the `/dashboard` iframe proxy" wording: remove the *iframe usage*, not the proxy — the API calls depend on the proxy. Recorded as drift in §Notes.)

### Error handling
- `fetchJSON` already throws `Error("<status>: <text>")` on non-2xx and auto-handles 401 reload (loopback). Wrap list/detail loads in try/catch and render an inline error state + retry; do not let a failed mutation silently no-op.
- Treat `409` from approve/reject/edit as "stale state" (someone/something already moved this draft) — surface a toast/banner and **refetch**, do not retry blindly.
- Treat `404` from snooze/detail as "row disappeared" — drop it from the list and clear the detail.
- Reject requires a valid `reason_code`; block the Reject submit until one is chosen (and require free_text when `other`) to avoid a guaranteed 400.
- Empty list (`drafts: []`) is a normal state → render an explicit empty state ("No messages in this view"), not a spinner.

### Data structures (frontend)
- Single source row type `DraftRow` (above) drives both list and detail — no separate "inbox message" fetch is needed for Phase 1 since the join already includes `message` + `account` + `thread_history`.
- Selection state: `selectedDraftId: number | null`; derive the selected row from the in-memory list (or refetch via `api.inboxGetDraft`).
- Filters state: `{ status: string (csv); accountId?: number; channel?: string }`.

### Edge cases
- **Subject null:** email replies have `draft_subject=null` and sometimes `subject` empty → render "(no subject)".
- **Account object only on the list endpoint** (`/drafts`), not on `/drafts/[id]` — if you refetch detail via `inboxGetDraft`, carry `account` from the list row.
- **inbox_message id vs draft id confusion** is the top correctness trap: archive/snooze/mark-read take the **message** id (`row.inbox_message_id`), approve/reject/edit take the **draft** id (`row.id`). They differ (e.g. draft `5` ↔ message `713`).
- **Snooze `until` must be a future ISO instant with offset/Z** or it 400s.
- **Status invalid → 400:** only send statuses from the valid set in the `status` query param.
- **`channel` may be absent on legacy rows pre-backfill** — defensively default `row.channel ?? "email"` (045 backfill should make this non-null, but guard anyway).
- Long `body`/`thread_history` — render in a scroll container; don't blow the layout.
- Multi-account: the same thread can exist under different `account_id`s; rely on `account_id`/`account` to disambiguate, not on `from_addr`.

---

## Scope boundary
Files / modules this phase may touch (drafts only — per task constraints, **do not** deploy, touch mailbox2 files, run migrations, or git):
- `/home/bob/code/tbox/HermesBOX/hermes-agent-main/hermes-agent-main/web/src/pages/InboxPage.tsx` — rewrite from iframe to native master–detail.
- `/home/bob/code/tbox/HermesBOX/hermes-agent-main/hermes-agent-main/web/src/lib/api.ts` — add `inbox*` methods + exported result/row interfaces (reuse `fetchJSON`).
- (Optional, if extracted for clarity) new presentational components under `web/src/components/` and/or `web/src/pages/inbox/` for the list row + detail panel, using the existing `components/Card`. Keep additions minimal and in `web/src`.

**Explicitly out of scope for Phase 1:**
- `web_server.py` (no new Python endpoints, no DB layer — D-1). The `/dashboard/{path}` proxy stays as-is.
- `App.tsx` route/nav changes (the `/inbox` route + nav item already exist; no `:param` route — D-4).
- Any mailbox2 / mailbox-dashboard file, any migration, any n8n flow.
- Per-channel ingest/send (Phase 2/4), credentials page (Phase 3), deep-link detail URL.

---

## Hand-off to executor
Acceptance criteria (mirrored from ROADMAP Phase 1):
- [ ] An email message in `mailbox.inbox_messages` renders in the native Incoming Messages page (no iframe in the DOM/route tree). *(Verify against live data: `GET /dashboard/api/drafts` returns 18 email rows; at least one — e.g. draft id 5 / message 713 — must appear in the native list.)*
- [ ] Its draft can be edited, approved, rejected, and sent from the native detail page, and each action writes the corresponding `drafts.status` transition to Postgres. *(edit → `edited`; approve → `approved` (+send); reject → `rejected` (+`draft_feedback` row). Use the live endpoints above; confirm status flips via `GET /dashboard/api/drafts/[id]`.)*
- [ ] `/api/inbox`, `/api/drafts`, `/api/accounts`, `/api/credentials` each return 200 with correct payloads against the mailbox DB; `/api/credentials` never returns `secret_enc` to the client. *(Phase 1 reuse mapping: "inbox/drafts" = `GET /dashboard/api/drafts` (200, verified); "accounts" = `GET /dashboard/api/accounts` (200, verified). `credentials` has **no** Phase-1 endpoint and is deferred to Phase 3 — record as a known carve-out, not a Phase-1 gate. See §Notes.)*
- [ ] The `/dashboard` iframe and `InboxPage` iframe usage are removed (grep returns no live `/dashboard/queue` / `<iframe>` / `__AGENTBOX_INBOX_URL__` references in `web/src`); `InboxPage` now renders native. *(The reverse-proxy in `web_server.py` is intentionally retained — the native page calls `/dashboard/api/*` through it.)*

Verification commands the executor can run (read-only, against live):
- `ssh -o BatchMode=yes mailbox2 'curl -s "http://127.0.0.1:3001/dashboard/api/drafts?status=pending&limit=3"'`
- `ssh -o BatchMode=yes mailbox2 'curl -s "http://127.0.0.1:3001/dashboard/api/accounts"'`
- `ssh -o BatchMode=yes mailbox2 'grep -n "REJECT_REASON_CODES\|DRAFT_STATUSES" /home/mailbox/mailbox/dashboard/lib/types.ts'`
- Build gate (local, strict TS): `pnpm --dir /home/bob/code/tbox/HermesBOX/hermes-agent-main/hermes-agent-main/web build` (or the repo's typecheck) — must pass with `noUnusedLocals`/`noUnusedParameters`.
