# MBOX-468 — Port MBOX-465 Provider Onboarding (Microsoft 365 + IMAP) to the Hermes Dashboard

**Plan version:** v0.1
**Date:** 2026-06-08
**Branch:** `dustin/mbox-468` (isolated worktree — human review, do NOT auto-merge)
**Author:** Planner (synthesis of 3 exploration reports + direct verification)

---

## TL;DR

- Hermes has **neither** a mail-connect frontend surface **nor** the backend probe/connect routes today. This is a backend + frontend slice.
- **Scope v1 = full vertical slice: M365 + IMAP test-connection probe (no-persist) AND connect (persist).** Persistence is *in scope* but is implemented the **hermes way** — chmod-0600 JSON files under `$HERMES_HOME`, mirroring `shopify_accounts.py` / `google_accounts.py` — **NOT** the mailbox Postgres `mailbox.accounts` table.
- The brief's premise that hermes persists to "Postgres `mailbox.accounts` + `oauth_tokens` with AES-256-GCM" is **wrong for hermes_cli** (verified: no Postgres driver in core deps; `asyncpg` is only in the `[matrix]` extra; every existing connector is a 0600 JSON file store). Two of the three reports independently caught this. We do not port the Postgres path.
- The mailbox `setEmail` / `onboarding.stage` / `is_default` sentinel-adoption / `adopted` flag are **mailbox-Postgres onboarding concepts with no hermes analog** — dropped.
- Disjoint split: **backend** = `hermes_cli/*.py` only; **frontend** = `web/src/**` only. No shared files; the frontend touches the backend solely through the HTTP contract below.

---

## 1. Scope decision (explicit)

### In scope (v1)

| Item | Decision |
|---|---|
| M365 probe (token + inbox read) | **In** — port `test-graph-connection.ts` verbatim-of-behavior to Python `httpx` (core dep, confirmed `httpx[socks]==0.28.1`). |
| IMAP/SMTP probe (LOGIN + AUTH) | **In** — reimplement `test-connection.ts` with stdlib `imaplib` + `smtplib` (simpler than the source's hand-rolled `net`/`tls` sockets; zero new deps). |
| Connect orchestration (probe → 422-on-fail → test\|connect → persist) | **In** — port `connect-graph.ts` / `connect-imap.ts` orchestration shape. |
| Persistence on `mode:'connect'` | **In, but file-store** — new `$HERMES_HOME/mail_accounts/<email>.json`, 0600, secret encrypted at rest (see §5). |
| Onboarding-steps content (9-step M365, 4-step IMAP, 4 IMAP presets) | **In** — port `onboarding-steps.ts` data **verbatim** into a TS module on the frontend. |
| ProviderOnboarding UI + mount point | **In** — new `SettingsMailPage.tsx` at `/settings/mail`, reached via the Settings hub. |
| List + delete connected mail accounts | **In** — `GET /api/accounts/mail`, `DELETE /api/accounts/mail/{id}` (round out CRUD, feed the page's connected-list). |

### Deferred (clearly noted follow-ups — do NOT build in v1)

| Deferred item | Why | Tracking |
|---|---|---|
| Writing to mailbox Postgres `mailbox.accounts` / feeding the MailBOX ingestion pipeline | hermes_cli has no Postgres driver in core; the n8n ingestion path uses its own hardcoded creds (the "Google single source of truth" crux in MEMORY). Reconciling the hermes file-store with `mailbox.accounts` is a **separate cross-store epic**, not this slice. | Follow-up issue (cf. MEMORY: google-single-source-of-truth, MBOX-464) |
| `setEmail` / `onboarding.stage` advance | No onboarding state machine exists in hermes; the settings page is the only caller (equivalent to `advanceOnboarding:false`). | n/a — drop |
| `is_default` sentinel adoption + `adopted` response field | Couples to mailbox migration-033 sentinel row that does not exist host-side. | Drop; `adopted` omitted from response (or always `false`). |
| n8n credential push (so the agent can actually send/receive on the new account) | Same boundary as the existing Gmail STAQPRO-152 / IMAP DR-56 handoff — out of the onboarding-UX slice. | Follow-up issue |

**Load-bearing assumption to confirm before merge:** the new account records produced by this slice are **dashboard-side SoT only**. They do not yet wire into any send/receive runtime. If product needs these mailboxes live in the agent, that is the deferred n8n-credential-push follow-up. Reviewer must accept this boundary.

---

## 2. Shared API contract (both implementers code to this)

Two session-gated POST routes plus list/delete. **NOT** added to `dashboard_auth/public_paths.PUBLIC_API_PATHS` (those carry credentials in the body; only OAuth browser redirects belong in the allowlist — verified gate at `web_server.py:289`). All requests carry the `X-Hermes-Session-Token` header automatically attached by the frontend `fetchJSON`.

### 2.1 `POST /api/accounts/microsoft`

**Request body** (pydantic `GraphConnectBody`, mirrors `lib/schemas/graph-connect.ts`):

```jsonc
{
  "mode": "test",            // "test" | "connect"  (default "test")
  "email": "ops@acme.com",   // required, RFC-email, lowercased server-side
  "display_label": "Acme Ops",   // optional, 1..100
  "tenant_id": "…",          // required, 1..128
  "client_id": "…",          // required, 1..128
  "client_secret": "…",      // required, 1..2048  — VALUE not secret-id; never echoed
  "mailbox": "ops@acme.com"  // optional email; defaults to `email`, lowercased
}
```

> Note: contract uses **`mode:"connect"`** (not the source's `"save"`) for the persist path, to match hermes' "connect a provider" verb. The frontend and backend both use `"connect"`. (Source schema's literal was `"save"`; we rename at the boundary — stated here once so both sides agree.)

**Probe (always runs first):**
- LEG 1 mint token: `POST https://login.microsoftonline.com/{quote(tenant_id)}/oauth2/v2.0/token`, `application/x-www-form-urlencoded`, body `client_id, client_secret, grant_type=client_credentials, scope=https://graph.microsoft.com/.default`. 8s timeout.
- LEG 2 read inbox: `GET https://graph.microsoft.com/v1.0/users/{quote(mailbox)}/mailFolders/inbox/messages?$top=1&$select=id`, `Authorization: Bearer <token>`. 8s timeout. Skipped (detail "Skipped — token acquisition failed") if LEG 1 fails.
- `ok = token.ok && mailbox.ok`. Verdict strings ported verbatim from `graphTokenVerdict` / `graphMailboxVerdict` (AADSTS codes, 401/403/404/429 mapping). **Secret never appears in any detail string.**

**Responses:**

| Case | Status | Body |
|---|---|---|
| probe fail | **422** | `{ "ok": false, "token": {"ok": bool, "detail": str}, "mailbox": {"ok": bool, "detail": str} }` |
| `mode:test` + probe ok | **200** | `{ "ok": true, "tested": true, "token": {...}, "mailbox": {...} }` |
| `mode:connect` + probe ok | **200** | `{ "ok": true, "account_id": "<id>", "provider": "microsoft" }` |
| persist error (connect only) | **500** | `{ "ok": false, "error": "<safe message>" }` |
| body validation fail | **422** | FastAPI/pydantic default validation envelope (see §2.4) |

### 2.2 `POST /api/accounts/imap`

**Request body** (pydantic `ImapConnectBody`, mirrors `lib/schemas/imap-connect.ts`):

```jsonc
{
  "mode": "test",            // "test" | "connect"  (default "test")
  "email": "me@host.com",    // required, RFC-email, lowercased server-side
  "display_label": "…",      // optional, 1..100
  "imap_host": "imap.host.com",  // required, 1..255
  "imap_port": 993,          // int 1..65535, default 993
  "smtp_host": "smtp.host.com",  // required, 1..255
  "smtp_port": 587,          // int 1..65535, default 587
  "username": "me@host.com", // required, 1..320
  "app_password": "…"        // required, 1..1024 — never echoed
}
```

**Probe (both legs run in parallel; both must pass):**
- IMAP leg: `imaplib.IMAP4_SSL(imap_host, imap_port, timeout=8)` → `.login(username, app_password)`. Map success → "IMAP login OK"; `imaplib.error` (NO/BAD) → "IMAP login rejected: …"; other → "IMAP: <msg>". Verdict strings from `imapLoginVerdict`.
- SMTP leg: port 465 → `smtplib.SMTP_SSL(timeout=8)`; else `smtplib.SMTP(timeout=8)` + `.starttls()`. Then `.login(username, app_password)`. Success → "SMTP login OK"; `SMTPAuthenticationError` → "SMTP auth failed: bad username/password (535)"; `SMTPException`/other → "SMTP auth failed (<code>)" / "SMTP: <msg>". Verdict strings from `smtpVerdict`.
- `ok = imap.ok && smtp.ok`. **app_password never appears in any detail string.**

**Responses:**

| Case | Status | Body |
|---|---|---|
| probe fail | **422** | `{ "ok": false, "imap": {"ok": bool, "detail": str}, "smtp": {"ok": bool, "detail": str} }` |
| `mode:test` + probe ok | **200** | `{ "ok": true, "tested": true, "imap": {...}, "smtp": {...} }` |
| `mode:connect` + probe ok | **200** | `{ "ok": true, "account_id": "<id>", "provider": "imap" }` |
| persist error | **500** | `{ "ok": false, "error": "<safe message>" }` |
| body validation fail | **422** | pydantic envelope (see §2.4) |

### 2.3 List / delete

- `GET /api/accounts/mail` → `200 { "accounts": [ { "id": str, "provider": "microsoft"|"imap", "email": str, "display_label": str|null, "mailbox": str|null, "connected_at": str } ], "crypto_configured": bool }`. **Never** includes `client_secret` / `app_password` / `provider_secret_enc`.
- `DELETE /api/accounts/mail/{id}` → `200 { "removed": bool }`.

`crypto_configured` lets the page show a non-blocking notice if the at-rest key env var is unset (see §5); `mode:connect` hard-fails 500 when crypto is required but unconfigured.

### 2.4 422 detail shape — readable on both paths

There are **two distinct 422 shapes** the frontend must distinguish:

1. **Probe failure 422** (semantic): the body is `{ ok:false, token/mailbox }` or `{ ok:false, imap/smtp }`. The frontend renders the per-leg `detail` strings inline. This is the primary UX signal.
2. **Body validation 422** (pydantic): FastAPI's default `{ "detail": [ {"loc":[...], "msg":"…", "type":"…"} ] }`. The frontend should detect `Array.isArray(body.detail)` and surface the first `msg` as a generic "Invalid input" banner. To keep this readable, the backend SHOULD catch `RequestValidationError` paths it controls and, where practical, prefer returning the semantic shape; but the canonical contract is: **`ok:false` present ⇒ probe shape; `detail` array present ⇒ validation shape.**

`fetchJSON` throws `Error(\`${status}: ${text}\`)` on non-2xx, so the page wraps the test/connect call in try/catch, parses the thrown text as JSON, and branches on the two shapes. (The page must read the raw response text — confirm `fetchJSON` exposes the body on the thrown error; if it only carries `status: text`, the page parses `text`.)

**Invariant (load-bearing, both routes):** a failed probe returns 422 and **never persists**. Persistence happens strictly after a passing probe on `mode:connect`. No write path is reachable without a green probe.

---

## 3. Backend task (hermes_cli — Python only)

**Owner:** backend implementer. **Touch only** `hermes-agent-main/hermes-agent-main/hermes_cli/**`.

### Files

| File | Action | Notes |
|---|---|---|
| `hermes_cli/mail_accounts.py` | **NEW** | Connect orchestration + file-store persistence + list/delete. Clone the module layout of `shopify_accounts.py` (reuse its `_write_json_600` atomic 0600 idiom — `os.open(O_CREAT,0o600)` + `os.replace`, verified at `shopify_accounts.py:185`). Records live under `$HERMES_HOME/mail_accounts/<email>.json`. `list_accounts()` strips the encrypted secret (mirror `list_stores` omitting raw token). |
| `hermes_cli/mail_probe.py` | **NEW** | Pure probes: `probe_graph(...)` (httpx, token+inbox legs, 8s timeouts, verdict classifiers ported verbatim) and `probe_imap_smtp(...)` (`imaplib.IMAP4_SSL` + `smtplib`, never raises — returns `{ok, detail}` legs). Run both IMAP/SMTP legs concurrently (threads or `concurrent.futures`); these are blocking. |
| `hermes_cli/token_crypto.py` | **NEW** | AES-256-GCM via `cryptography` (reachable — gateway already uses it). Packed format `base64(iv).base64(tag).base64(ciphertext)`, 12-byte IV, 16-byte tag — **byte-compatible** with the mailbox `encryptToken` (`lib/oauth/google.ts:104`) so the column stays cross-decryptable if ever needed. Key from a `HERMES_`-namespaced 32-byte-hex env var (e.g. `HERMES_MAIL_SECRET_KEY`), with the same "unset / wrong length" hard-fail guards as the source `readKey()`. **If key unset and `mode:connect`: hard-fail 500, never store plaintext.** |
| `hermes_cli/web_server.py` | **EDIT** | Add the 4 routes near the shopify account block (`@app.get("/api/shopify/accounts")` at L1723, `@app.delete` at L1737). Bodies = pydantic `BaseModel` (pattern: `CalendarEventBody`). Run all blocking probe/persist work via `await loop.run_in_executor(...)` (pattern at L1546/L1711). Lazy-import `from hermes_cli import mail_accounts` inside each handler (matches every other route). Return `JSONResponse(result_body, status_code=result_status)`. |

### Backend rules

- **Do NOT** add the new POST routes to `dashboard_auth/public_paths.py`. They stay session-gated (verified gate at `web_server.py:289`).
- **Do NOT** import or add any Postgres/asyncpg dependency. File-store only.
- **Do NOT** let `imaplib`/`smtplib`/`httpx` exceptions 500 the route — the probe layer catches everything and maps to `ok:false`/`detail`. A 500 is reserved for *persist* failures only.
- Enforce 8s connect+read timeouts on every outbound socket/HTTP call.
- `urllib.parse.quote` the `tenant_id` and `mailbox` before URL interpolation (SSRF/path-injection hygiene — source uses `encodeURIComponent`).
- Never log request bodies; scrub `client_secret`/`app_password` from any exception repr before returning or logging.

---

## 4. Frontend task (hermes/web — React/TS only)

**Owner:** frontend implementer. **Touch only** `hermes-agent-main/hermes-agent-main/web/src/**`.

### Files

| File | Action | Notes |
|---|---|---|
| `web/src/lib/mailOnboardingSteps.ts` | **NEW** | Port `lib/mail/onboarding-steps.ts` **verbatim** (data only): `PROVIDER_ONBOARDING` (9-step Microsoft, 4-step IMAP, 4 `imapPresets`: Gmail / Fastmail / Zoho / Generic), `GRAPH_PERMISSION='Mail.ReadWrite'`, `DEFAULT_IMAP_PORT=993`, `DEFAULT_SMTP_PORT=587`, and the `produces[]` field map. **Drop** the Gmail `mode:'oauth'` entry (already satisfied by the existing hermes `/api/google` flow — per scope discipline, only Microsoft + IMAP). |
| `web/src/pages/SettingsMailPage.tsx` | **NEW** | The page. Provider picker (Microsoft 365 \| IMAP) → data-driven onboarding walkthrough (mirror `ProviderOnboarding.tsx` StepRow/PresetRow, restyled with hermes tokens) → credential form. **Two-step state machine cloned from `SettingsShopifyPage.tsx:saveAppCredentials` (L140-156)**: "Test connection" (`mode:'test'`) renders per-leg detail; gates an enabled "Connect" (`mode:'connect'`). Banner pattern copied from `SettingsGooglePage.tsx` (L149-165). Connected-list + Remove (window.confirm + removing-spinner) from either page. Use `@nous-research/ui` `Card/Button/Badge/Spinner` + raw `<input>`/`<select>` with theme-token classes (no Input/Select component exists — match the raw-input idiom). Title via `usePageHeader().setTitle(...)`. **Re-map** any source Tailwind tokens (`bg-bg-deep`, `text-ink-muted`, `text-accent-orange`) to hermes nous tokens (`text-secondary`, `border-border`, `text-tertiary`, `brand`). |
| `web/src/lib/api.ts` | **EDIT** | Add `connectMicrosoft(body)`, `connectImap(body)`, `listMailAccounts()`, `removeMailAccount(id)` to the `api` object (POST shape modeled on `setEnvVar`/`createGoogleCalendarEvent`; list/remove on `listShopifyAccounts`/`removeShopifyAccount` L834). Add TS interfaces near `ShopifyAccount`: `MailAccount`, `MailAccountsResponse`, `GraphConnectBody`, `ImapConnectBody`, `GraphProbeResult`, `ImapProbeResult`, `MailConnectResult`. **No response type includes the secret.** |
| `web/src/App.tsx` | **EDIT** | `import SettingsMailPage from "@/pages/SettingsMailPage"` (~L77 by `SettingsShopifyPage`) and add `"/settings/mail": SettingsMailPage,` to `BUILTIN_ROUTES_CORE` (L108-133). Map-driven router auto-mounts it. |
| `web/src/pages/SettingsHubPage.tsx` | **EDIT** | Append to `CONNECTION_ITEMS` (L56-75): `{ path: "/settings/mail", label: "Mail accounts", icon: Mail, description: "Connect Microsoft 365 or IMAP mailboxes" }`. `Mail` icon already imported. |

### Frontend rules

- The form is a **credential-bearing JSON POST**, NOT an OAuth redirect. Model state on Shopify's inline `saveAppCredentials`, **not** the Google/Shopify `window.location.assign` redirect callbacks.
- Secrets go only in the POST body — never a query string, never persisted to localStorage, never echoed into the connected-list.
- Distinguish the two 422 shapes per §2.4 (probe `ok:false` vs validation `detail[]`).
- Hardcoded English strings are fine (matches existing settings pages; i18n is an acknowledged follow-up).
- Frontend imports **nothing** from the backend except via the HTTP contract in §2.

---

## 5. Credential / threat-model review flags (human must review before merge)

1. **At-rest key provisioning + plaintext-guard.** `HERMES_MAIL_SECRET_KEY` (32-byte hex) must be provisioned on the box (installer STAGE-7.6 overlay, analogous to mailbox's `MAILBOX_OAUTH_TOKEN_KEY`). If unset, `mode:connect` MUST hard-fail (500) — it must NEVER store `client_secret`/`app_password` in plaintext. `GET /api/accounts/mail` returns `crypto_configured:false` so the UI warns. **Reviewer decision:** confirm key provisioning is an accepted operator setup step, or explicitly accept chmod-0600-only (no encryption) as the trust model (the rest of hermes' file-store secrets — Shopify token, Google token — are 0600 plaintext; mail secrets *could* match that precedent). Default recommendation: encrypt, because Graph app-secrets grant standing whole-mailbox access.
2. **Probe-before-persist invariant.** The "422 on probe fail, never persist unvalidated creds" ordering is the core safety property. Any regression writes attacker-supplied or typo'd creds. Reviewer should confirm the persist call is unreachable without a green probe in both orchestrators.
3. **Never-echo-secret.** `client_secret` / `app_password` must never appear in any response body, log line, or exception string. Verdict detail strings are pre-sanitized in the source (only AADSTS codes / SMTP/IMAP status, never the secret) — preserve when porting. `GET` list omits the encrypted column. Confirm no request-body logging.
4. **SSRF / outbound surface.** `mode:test` makes the **server** open outbound connections to **operator-supplied** `imap_host`/`smtp_host` (arbitrary host:port) and to fixed Microsoft endpoints. An authenticated operator could point the IMAP/SMTP probe at internal addresses (169.254.169.254, 10.x, localhost:other-ports). Bounded today: single-tenant operator-trusted appliance, session-gated routes, hard 8s timeouts, and a non-mail port won't complete IMAP LOGIN / SMTP AUTH (limited exfil). **Reviewer decision:** accept for single-tenant, OR add a private-IP/host denylist before any multi-tenant exposure. Document the trust boundary either way.
5. **Session-gate confirmation.** Verify the two POST routes are covered by both the loopback (`auth_middleware`) and gated (`gated_auth_middleware`) paths and are **absent** from `PUBLIC_API_PATHS`. A credential-accepting endpoint accidentally allowlisted = unauthenticated secret intake.
6. **Graph app-only standing access.** A stored Graph `client_secret` (client-credentials, `Mail.ReadWrite` application perm) grants standing access to the whole mailbox with no user present. Rotation/revoke is operator-side in Azure. Note in operator docs (parallel to `shopify_accounts` uninstall-to-revoke comment).
7. **No live-runtime wiring (scope boundary).** These records are dashboard-side SoT only; they do not yet feed send/receive. Reviewer must accept that "connected" here ≠ "the agent can use this mailbox" until the deferred n8n-credential-push follow-up. Avoids a false sense that onboarding is end-to-end.

---

## 6. Source → target porting map (quick reference)

| Source (READ-ONLY, `mailbox/dashboard/…`) | Target (hermes) |
|---|---|
| `lib/mail/test-graph-connection.ts` | `hermes_cli/mail_probe.py` `probe_graph` (httpx) |
| `lib/mail/test-connection.ts` | `hermes_cli/mail_probe.py` `probe_imap_smtp` (imaplib+smtplib) |
| `lib/mail/connect-graph.ts` / `connect-imap.ts` | `hermes_cli/mail_accounts.py` orchestration (drop `advanceOnboarding`/`setEmail`) |
| `lib/queries-accounts.ts` (Postgres) | **NOT ported** → `hermes_cli/mail_accounts.py` file-store (drop `is_default`/`adopted`) |
| `lib/oauth/google.ts` `encryptToken` | `hermes_cli/token_crypto.py` (byte-compatible packing) |
| `lib/schemas/graph-connect.ts` / `imap-connect.ts` | pydantic `GraphConnectBody` / `ImapConnectBody` in `web_server.py` |
| `lib/mail/onboarding-steps.ts` | `web/src/lib/mailOnboardingSteps.ts` (verbatim data, drop Gmail oauth entry) |
| `app/settings/accounts/ProviderOnboarding.tsx` | renderers inside `web/src/pages/SettingsMailPage.tsx` (re-styled) |

---

## 7. Disjoint-split guarantee

- **Backend files:** `hermes_cli/mail_accounts.py` (new), `hermes_cli/mail_probe.py` (new), `hermes_cli/token_crypto.py` (new), `hermes_cli/web_server.py` (edit).
- **Frontend files:** `web/src/lib/mailOnboardingSteps.ts` (new), `web/src/pages/SettingsMailPage.tsx` (new), `web/src/lib/api.ts` (edit), `web/src/App.tsx` (edit), `web/src/pages/SettingsHubPage.tsx` (edit).
- **No shared files.** The only contract between halves is §2 (HTTP). Either half can be implemented and tested against the §2 contract independently (frontend against a stub returning the §2 bodies; backend against `curl`).
