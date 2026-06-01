# Context — Phase 3: Extend the Keys/Env page for all creds (credentials-keys)
Source PRD section: unified-inbox-prd.v0.1.0.md (v0.2.0) §Decisions D4/D5, §Target architecture component 5, §Phase 3, §Key risks ("Credential write-through is security-critical"). ROADMAP-v1.0.0.md Phase 3.

> **Reuse-first (D5).** This phase EXTENDS the existing Hermes `EnvPage` and the LIVE mailbox `/api/accounts(+imap,+microsoft)` machinery. The mailbox already ships the exact test/save/rotate primitive Phase 3 needs (probe → 422-on-fail → encrypt-and-persist → secret-never-echoed). Phase 3 is wiring + a UI group, NOT a new credential subsystem. Do not rebuild encryption, the accounts registry, or the connect probes.

---

## Ground truth (LIVE code, verified 2026-06-01)

These are the reusable primitives this phase builds on. Paths are on **mailbox2** (`ssh mailbox2`) unless marked Hermes (workstation).

### A. The mailbox already has a test-connection + encrypted-persist pattern
- `dashboard/lib/mail/connect-imap.ts` (`connectImap`) and `dashboard/lib/mail/connect-graph.ts` (`connectGraph`) are the canonical orchestration: **probe → if `!probe.ok` return `422` (never persist) → if `mode:'test'` return `200 {ok,tested}` → if `mode:'save'` encrypt secret + insert account → `200 {ok, account_id}`**. The app-password / client-secret is **never echoed back**.
- Exposed (operator-facing, basic_auth gated, NOT `/api/internal`):
  - `POST /api/accounts/imap` → `connectImap(body, {advanceOnboarding:false})` — IMAP/SMTP mailbox, body = `imapConnectBodySchema`.
  - `POST /api/accounts/microsoft` → `connectGraph(body, {advanceOnboarding:false})` — M365/Graph app-only creds, body = `graphConnectBodySchema`.
  - `GET /api/accounts` (`?detail=1` → provider+created_at; `?calendar=1` → +calendar_connected) — the connected-inbox list.
  - `POST /api/accounts` — registry-only create (gmail default; imap/microsoft are registry placeholders unless created via the imap/microsoft routes).
  - `PATCH /api/accounts/[id]` — edit `display_label`/`provider`, `make_default:true`.
  - `DELETE /api/accounts/[id]` — `404` not found, `409` (`cannot_delete_default` | `account_has_data`).
- `mode:'test'`/`mode:'save'` enums live in `dashboard/lib/schemas/imap-connect.ts` and `graph-connect.ts`. Both already document "the app-password is never returned and is stored AES-256-GCM-encrypted (migration 040)".

### B. Encryption already exists (do not reinvent)
- `dashboard/lib/oauth/google.ts`: `encryptToken(plaintext)` / `decryptToken(packed)`, `ALGO='aes-256-gcm'`, key from env **`MAILBOX_OAUTH_TOKEN_KEY`** (32-byte hex; throws if unset/wrong length). Packed format `iv.tag.ciphertext` (base64, dot-joined). State HMAC uses a **separate** secret `MAILBOX_OAUTH_STATE_SECRET` (key separation already practiced).
- Secrets land in `mailbox.accounts.provider_secret_enc` (the column IMAP app-password and Graph client-secret share). OAuth refresh tokens live in the `oauth_tokens` table via `getConnection(provider, accountId)` (returns `{connected}` status, never the raw token to the client).

### C. LIVE schema (post-045, channel-aware) — the write-through targets
- `mailbox.accounts(id, email_address, display_label, is_default, created_at, provider, provider_config jsonb, provider_secret_enc, channel default 'email', enabled)`. `provider` enum today = `MAIL_PROVIDERS = ['gmail','imap','microsoft']` (`dashboard/lib/types.ts`). **`channel` and `enabled` already exist** — Phase 0 (migration 045) added them. There is **no separate `credentials` table on the live box yet**; the PRD's `credentials(kind,provider,account_ref,secret_enc,...)` is the Phase-0 design target. **Decision below resolves which store Phase 3 writes to.**
- Live data: 3 accounts (`primary@appliance.local` default, `consultingfutures@gmail.com`, `dustin@heronlabsinc.com`).

### D. Hermes EnvPage (workstation) — what we extend
- `web/src/pages/EnvPage.tsx`: composes `<OAuthProvidersCard/>` (section `#section-oauth`) + LLM-provider key groups (`ProviderGroupCard`, prefix-matched `PROVIDER_GROUPS`) + `EnvCategoryCard` sections (`tool`/`messaging`/`setting`). Sub-nav (`setAfterTitle`) lists OAuth, Providers, + present categories. Env CRUD via `api.getEnvVars/setEnvVar/deleteEnvVar/revealEnvVar` → `/api/env*` (writes `~/.hermes/.env`).
- `web/src/components/OAuthProvidersCard.tsx`: per-provider connect/disconnect, `logged_in`/`expires_at`/`token_preview` status, `ConfirmDialog` for destructive disconnect. Pattern to mirror for channel-account connect/rotate/test rows.
- `web/src/lib/api.ts`: `fetchJSON`. **`/api/*` gets `X-Hermes-Session-Token`; `/dashboard/*` does NOT** and is the unauthenticated-loopback path to the mailbox API through the Hermes reverse-proxy on :9119 (mailbox Next.js basePath=`/dashboard`, so mailbox `/api/accounts` is reachable at **`/dashboard/api/accounts`**). `tsconfig` strict: `noUnusedLocals`/`noUnusedParameters`.

---

## Decisions captured (the discuss step)

- **Write-through target (the key gray area): consume the LIVE mailbox `/api/accounts(+imap,+microsoft)` via `/dashboard/api/...` — do NOT build a parallel Python/Hermes credential store.** Rationale: D5 reuse-first + the mailbox already owns encryption (`encryptToken`), the `provider_secret_enc` column, the probe-and-persist orchestration, and the registry-mutation routes. Hermes is the **UI shell**; the mailbox is the **system of record** for channel creds (PRD "Native UI needs DB access → consume the mailbox API"). Phase 3 adds React + thin `api.ts` methods that POST to `/dashboard/api/accounts/{imap,microsoft}` and the per-channel test/rotate endpoints. The PRD's unified `credentials` table is owned by Phase 0/the mailbox migrations — **Phase 3 reads/writes it only through mailbox API endpoints, never a direct PG connection from Hermes.** If a per-channel endpoint does not yet exist on the mailbox (e.g. a bot-token channel), Phase 3's deliverable is the **Hermes-side UI + api.ts stub plus a flagged dependency on a matching mailbox endpoint** — Phase 3 does not add routes to mailbox2 files (out of scope, see boundary).
- **Three credential KINDS, three UI affordances (D4):**
  1. **OAuth** (Gmail, Google Calendar, Drive, and any OAuth channel) → reuse `OAuthProvidersCard`'s connect/disconnect/expiry pattern. Rotate = re-run the OAuth login (existing flow). No raw secret in the UI.
  2. **App-password / connection creds** (IMAP/SMTP mailbox, M365/Graph client-secret) → a **"Channel accounts" card** that mirrors `connectImap`/`connectGraph`: form → **Test connection** (`mode:'test'`) → **Save** (`mode:'save'`) → row shows connected/last-verified; **Rotate** = re-open the form pre-filled with non-secret fields (host/port/username from `provider_config`) and a blank secret, submit `mode:'save'` again (overwrites `provider_secret_enc`).
  3. **Bot-token / API-key channels** (Telegram bot token, Slack bot token, Discord token) → reuse the **`ProviderGroupCard` / `messaging` `EnvCategoryCard`** env-var pattern for the token value, plus a **Test** button that calls a mailbox channel-test endpoint (see API shapes). These map to env/`.env` + (where the channel is account-modeled) an `accounts` row with `channel='telegram'` etc.
- **UI placement:** a new **"Channels" / "Channel accounts" section** on `EnvPage` between `#section-oauth` and `#section-providers` (so OAuth stays first per existing priority). Add a sub-nav entry `{id:'section-channels', label:'Channels'}` in the `sections` memo. Reuse `Card`/`CardHeader`/`Badge`/`ConfirmDialog`/`Toast`/`useToast` already imported in EnvPage and OAuthProvidersCard. No new design system.
- **Test-connection semantics per channel:**
  - IMAP/SMTP → `POST /dashboard/api/accounts/imap` `mode:'test'` (raw-socket probe; bad creds → `422 {ok:false,imap,smtp}`).
  - M365/Graph → `POST /dashboard/api/accounts/microsoft` `mode:'test'` (token + inbox probe; `422` on fail).
  - Gmail/OAuth → "test" = the existing `getConnection().connected` status (already surfaced by `GET /api/accounts?calendar=1` for calendar; Gmail connectivity is the `logged_in` state on the OAuth card). No new probe needed.
  - Bot-token channels → **mailbox endpoint dependency** (flagged): a `mode:'test'` probe analogous to imap/microsoft (e.g. Telegram `getMe`, Slack `auth.test`). Hermes calls it; the probe lives in mailbox code (Phase 2/3 mailbox work), not in Hermes.
- **Status + last_verified write-through:** the mailbox `connect*` save path is the only writer of `provider_secret_enc`; a successful `mode:'save'` (or a future `mode:'test'` that records) sets the credential `status`/`last_verified_at`. Phase 3 UI **reads** status from `GET /api/accounts?detail=1` (+ a status field once the mailbox surfaces `credentials.status`/`last_verified_at`); Hermes does not compute status itself.
- **No secret readback (PRD-mandated, already enforced):** the LIVE routes never return `app_password`/`client_secret`/`provider_secret_enc`. Phase 3 must NOT add a "reveal" affordance for channel secrets (unlike the LLM-key `revealEnvVar` flow, which is acceptable for `.env` API keys but **must not** be extended to channel app-passwords/bot-tokens that are encrypted at rest). Reveal stays only on the existing env-var card for non-encrypted `.env` keys.

### API shapes (consumed by Hermes; all via `/dashboard/api/...`, NO session token)
- **List:** `GET /dashboard/api/accounts?detail=1` → `{accounts:[{id, email_address, display_label, is_default, provider, created_at /*, channel, enabled, status, last_verified_at once surfaced */}]}`.
- **Add/Test IMAP:** `POST /dashboard/api/accounts/imap` body `{mode:'test'|'save', email, display_label?, imap_host, imap_port=993, smtp_host, smtp_port=587, username, app_password}` → `200 {ok:true,tested:true,imap,smtp}` (test) | `200 {ok:true,account_id,adopted}` (save) | `422 {ok:false,imap,smtp}` (bad creds) | `500 {ok:false,error}`.
- **Add/Test M365:** `POST /dashboard/api/accounts/microsoft` body `{mode, email, display_label?, tenant_id, client_id, client_secret, mailbox?}` → same shape family (`200`/`422`/`500`).
- **Rotate:** re-`POST` the same imap/microsoft route with `mode:'save'` and the new secret (overwrites `provider_secret_enc` for the matching `email`/account). *(Confirm with mailbox owner whether `createImapAccount`'s "adopt existing account" path updates the secret on an existing email, or whether a dedicated rotate endpoint is needed — flagged as a dependency below.)*
- **Disable / remove:** `DELETE /dashboard/api/accounts/[id]` → `{deleted:true,id}` | `404` | `409 {error:'cannot_delete_default'|'account_has_data'}`. Prefer **toggle `enabled=false`** (via `PATCH`, once the mailbox exposes it) over delete for accounts with history; delete only for never-used registry rows.
- **Hermes-side `api.ts` additions (new methods, mirror existing style):** `getChannelAccounts()` → `fetchJSON('/dashboard/api/accounts?detail=1')`; `testImapAccount(body)`/`saveImapAccount(body)` → POST imap; `testMicrosoftAccount/saveMicrosoftAccount` → POST microsoft; `deleteChannelAccount(id)` → DELETE. **No `X-Hermes-Session-Token` on `/dashboard/*` calls.**

### Error handling
- `422` (bad creds) → surface `imap.detail`/`smtp.detail` (e.g. "SMTP auth failed: bad username/password (535)", "IMAP login rejected") inline on the form via `showToast(..., 'error')` and a per-field error; **do not** clear the form (let the operator fix the secret and retry). Never persist on `422`.
- `409` on delete → toast the human message ("cannot delete default inbox" / "account has data") and keep the row; do not retry.
- `500` → generic "connection save failed" toast; the mailbox logged the detail. Surface `body.error` if present.
- Network/proxy failure to `/dashboard/*` → the reverse-proxy on :9119 may be down or the mailbox unreachable; toast "mailbox API unreachable" and leave existing rows rendered (degrade, don't blank the page) — mirror `OAuthProvidersCard`'s `.catch(onError)` + keep `providers` null/last-good.
- Missing `MAILBOX_OAUTH_TOKEN_KEY` on the mailbox → save returns `500` with the encryption error; treat as a server-config error, surface "encryption key not configured on appliance".

### Data structures (Hermes-side types to add in `api.ts`)
- `ChannelAccount { id:number; email_address:string; display_label:string|null; is_default:boolean; provider:'gmail'|'imap'|'microsoft'|string; channel:string; enabled?:boolean; created_at?:string; status?:'connected'|'expired'|'missing'; last_verified_at?:string|null }`.
- `ImapConnectBody`/`GraphConnectBody` mirroring the zod schemas above (`mode` field drives test vs save).
- `ConnectResult { ok:boolean; tested?:boolean; account_id?:number; adopted?:boolean; imap?:{ok:boolean;detail:string}; smtp?:{ok:boolean;detail:string}; error?:string }`.

### Edge cases
- **Default account is undeletable** (`409 cannot_delete_default`) — UI must hide/disable the delete button on the `is_default` row and offer make-default-elsewhere first.
- **Adopt vs new account** on IMAP save: `connectImap` adopts the seeded sentinel account on a fresh box but inserts a NEW non-default account on a live box. Live box = always a new account; UI should expect `account_id` to be a new id for a new email, or the existing id when re-saving the same email (rotate).
- **Rotate must invalidate the old secret on next test** (acceptance criterion). Because save overwrites `provider_secret_enc`, a subsequent `mode:'test'` with the OLD secret should `422` — but the rotate UI submits the NEW secret, so verification is: save new → test with old (manually) → expect `422`. Confirm the adopt-path updates the secret (dependency).
- **Email vs non-email channels:** `accounts.email_address` is non-null today; a Telegram/Slack account has no email. Until the mailbox relaxes/repurposes that column (Phase 0/2), bot-token channels are modeled via `.env` + a `channel`-tagged row whose `email_address` carries a synthetic identity (e.g. `telegram:@bot`). **Flagged** — confirm the live `accounts` insert path accepts non-email identities before building bot-token account rows.
- **noUnusedLocals/noUnusedParameters** (tsconfig strict) — any new component prop/import must be used or the Hermes web build fails.
- **OAuth expiry already rendered** by `OAuthProvidersCard` (`formatExpiresAt`); reuse it for OAuth-kind channel status rather than recomputing.

---

## Threat model (PRD-mandated — must exist and be referenced before any credential-write code merges)

Per PRD §Key risks ("Credential write-through is security-critical… threat-model before building Phase 3") and ROADMAP AC. The threat model is a **deliverable of this phase** and the executor must produce/reference it. Key requirements, grounded in the LIVE crypto:

| Threat | Mitigation (LIVE today / required) |
|---|---|
| Secret readback via API | **No endpoint returns the plaintext secret.** LIVE imap/microsoft routes never echo `app_password`/`client_secret`; `provider_secret_enc` is never serialized to the client. Phase 3 adds NO reveal for channel secrets. |
| Secret at rest | AES-256-GCM via `encryptToken` (`MAILBOX_OAUTH_TOKEN_KEY`, 32-byte hex, throws if absent). Stored as `iv.tag.ciphertext`. Phase 3 must not add a code path that writes a plaintext secret to PG or `.env`. |
| Key compromise / key mgmt | Token-encryption key (`MAILBOX_OAUTH_TOKEN_KEY`) is distinct from the state HMAC secret (`MAILBOX_OAUTH_STATE_SECRET`) — key separation already practiced; document rotation procedure for the encryption key (re-encrypt on rotation is out of Phase 3 scope but must be noted). |
| Unauthenticated `/dashboard/*` path | The mailbox API is reached via the Hermes reverse-proxy as **unauthenticated loopback** (no session token). Threat model must state that the trust boundary is the loopback/proxy itself; Phase 3 introduces no new public surface but inherits this. Note it as a documented risk, not a Phase 3 fix. |
| Credentials accepted without validation | LIVE routes **probe before persist** (`422` on bad creds; never persist unvalidated). Phase 3 must always go through `connect*` (never a raw insert that bypasses the probe). |
| Audit / rotation evidence | `credentials.status`/`last_verified_at` (Phase 0 target) record verification; Phase 3 surfaces them. Threat model should require an audit trail on rotate (who/when) even if minimal. |
| Bad-secret error leakage | Probe `detail` strings (e.g. SMTP 535) are operator-facing only behind the gated dashboard — acceptable; do not log full secrets. `connect*` already truncates server replies (`slice(0,200)`). |

---

## Scope boundary
Files / modules this phase MAY touch (Hermes web app only — `/home/bob/code/tbox/HermesBOX/hermes-agent-main/hermes-agent-main/web/src`):
- `pages/EnvPage.tsx` — add the Channels section + sub-nav entry.
- `components/` — **new** `ChannelAccountsCard.tsx` (+ optional `ChannelAccountForm.tsx` / connect modal), mirroring `OAuthProvidersCard.tsx` patterns. May reuse `DeleteConfirmDialog`, `ConfirmDialog`, `Toast`.
- `lib/api.ts` — add `ChannelAccount`/`ConnectResult` types + `getChannelAccounts`/`test*`/`save*`/`deleteChannelAccount` methods (all targeting `/dashboard/api/...`, **no** session token).
- `i18n` strings if new labels are added (match existing `t.*` usage).
- This artifact's threat-model section, or a sibling `THREAT-MODEL-phase-3-v1.0.0.md` under `docs/unified-inbox/`.

**Explicitly OUT of scope (do NOT touch):** any file on **mailbox2** (`/home/mailbox/mailbox/**`); mailbox migrations / the `credentials` table schema (Phase 0 owns it); the n8n credential API plumbing on the appliance; deploying; git; running migrations. New mailbox-side endpoints (bot-token test/rotate) are **dependencies to flag**, not Phase 3 code. Per-channel SEND (Phase 4) and channel ingestion (Phase 2) are out of scope.

---

## Hand-off to executor
Acceptance criteria (mirrored from ROADMAP-v1.0.0.md Phase 3):
- [ ] Every enabled channel's credentials are **addable, rotatable, and testable** from the Keys/Env page (no separate page exists). *(PRD Phase 3 Exit: "every channel's creds managed from the Keys page; tests pass.")*
- [ ] The **test-connection** action returns a pass/fail result per credential and updates `credentials.status` (`connected|expired|missing`) and `last_verified_at` accordingly. *(Hermes calls the mailbox test endpoints; status surfaces via `GET /dashboard/api/accounts?detail=1`. Where status is not yet surfaced by the mailbox, the executor flags the dependency rather than computing it client-side.)*
- [ ] A **rotate** action updates `secret_enc` (`provider_secret_enc`) in the credential store and the corresponding n8n stored credential; the **old secret no longer authenticates** on a subsequent test. *(Achieved via `mode:'save'` re-submit; verify the adopt-path overwrites the existing account's secret — flagged dependency if it does not.)*
- [ ] **No credential `secret_enc` value is ever returned to the client** in any `/api/credentials` (or `/dashboard/api/accounts*`) response — verified by inspecting payloads. *(Already enforced by LIVE routes; Phase 3 must add no reveal path for channel secrets.)*
- [ ] The **threat-model document exists and is referenced** before any credential-write code is merged. *(Section above, or sibling THREAT-MODEL file.)*

### Flagged dependencies (resolve with mailbox owner before/at execution; Phase 3 does not build them)
1. **Rotate semantics:** does `createImapAccount`/`connectGraph` save overwrite `provider_secret_enc` for an existing `email`, or is a dedicated `PATCH .../secret` / rotate endpoint required? Acceptance criterion #3 hinges on this.
2. **Bot-token channels (Telegram/Slack/Discord):** there is no LIVE per-channel test/save endpoint and `accounts.email_address` is non-null. Need (a) a mailbox `mode:'test'` probe per bot-token channel, and (b) confirmation that a non-email `channel`-tagged account row is insertable. Until both exist, bot-token creds are managed as `.env` keys + a flagged status row.
3. **`credentials` table + `status`/`last_verified_at` surfacing:** the live box stores secrets in `accounts.provider_secret_enc`; the PRD's separate `credentials` table and its `status`/`last_verified_at` fields must be surfaced by a mailbox API field before the UI can render real status. Until then, status = derived from `is_default`/presence + OAuth `logged_in`.
4. **n8n stored-credential write-through:** ROADMAP AC requires rotate to also update the n8n stored credential. The n8n credential API call lives on the appliance — Phase 3 (Hermes UI) depends on the mailbox save path performing it; confirm or flag.
