# Google Workspace — Universal Multi-Account Connect (PRD)

**Version:** 0.1.0
**Date:** 2026-06-05
**Owner:** Dustin Powers
**Box:** mailbox2 (AgentBOX dev) — dashboard `hermes-agent/web`, backend `hermes_cli/web_server.py`

## TL;DR

Today the box can read Gmail/Calendar only from a **single** Google account, and only
after authorizing the `google-workspace` skill **over CLI** (download a client secret,
paste an auth code). There's no dashboard UI and no multi-account support. This PRD
adds a **dashboard "Connect Google account" button** that runs a full OAuth
redirect→callback flow, stores **one token per email** so **multiple** accounts can be
connected, and makes the daily brief (and later Calendar/Drive/Contacts) **aggregate
across all connected accounts**. Hard prerequisite: a Google Cloud **OAuth Web client**
(operator action — see §6).

## 1. Current state (verified 2026-06-05)

- `HomePage.tsx` shows the "Connect Google" card when `GET /api/digest/brief` returns
  `connected: false`. `connected` = presence of `$HERMES_HOME/google_token.json`
  (`google_brief.py:google_connected()`).
- Connection is CLI-only via the `google-workspace` skill
  (`skills/productivity/google-workspace/scripts/setup.py`): `--client-secret PATH`,
  `--auth-url`, `--auth-code CODE`, `--check`, `--revoke`. Single token file.
- Box currently has **no** `google_token.json` and **no** `google_client_secret.json`
  (nothing connected, no OAuth client yet).
- Skill scopes: gmail.readonly/send/modify, calendar, drive, contacts.readonly,
  spreadsheets, documents.
- Calendar/Drive pages are placeholders. Contacts is a local CRM with a `source:google`
  badge (not a live Google sync).
- Funnel host: `https://mailbox2.tail377a9a.ts.net` (Tailscale Funnel on 443, Caddy
  basic-auth). Operator also browses via SSH tunnel `http://localhost:9119`. API served
  at `/api/*` (base path empty).

## 2. Goal & non-goals

**Goal:** From the dashboard, connect *N* Google accounts in a few clicks, no CLI/code
pasting; surface them everywhere the box uses Google.

**Non-goals (this version):** building out the Calendar/Drive pages themselves; Google
Contacts/People live sync (separate); per-account scope customization; domain-wide
delegation. Storage is designed so these are additive later.

## 3. Design

### 3.1 OAuth client & redirect URIs
One **Web application** OAuth client (operator creates in GCP). Register BOTH redirect
URIs so connect works from either entry point:
- `https://mailbox2.tail377a9a.ts.net/api/google/auth/callback` (funnel)
- `http://localhost:9119/api/google/auth/callback` (SSH tunnel)

Backend builds `redirect_uri` dynamically from the incoming request's scheme+host, so
the value sent to Google always matches the URL the operator is browsing from.
`client_secret.json` lives at `$HERMES_HOME/google_client_secret.json` (operator hands
the file off; placed via scp — no upload endpoint in v1).

### 3.2 Multi-account token storage
- New dir `$HERMES_HOME/google_accounts/<email>.json`, one token per account.
- New module `hermes_cli/google_accounts.py`: `list_accounts()`, `save_account(token)`,
  `load_account(email)`, `delete_account(email)`, `all_credentials()`.
- **Back-compat:** keep `$HERMES_HOME/google_token.json` as a mirror of the *primary*
  (first-connected) account so the existing `google_brief.py` keeps working unchanged
  during migration; brief is then upgraded to iterate `all_credentials()`.

### 3.3 Backend endpoints (`web_server.py`)
| Route | Method | Purpose |
|---|---|---|
| `/api/google/accounts` | GET | List connected accounts `[{email, scopes, connected_at, primary}]` |
| `/api/google/auth/start` | GET | Build Google auth URL (state cookie, dynamic redirect_uri, `access_type=offline`, `prompt=consent select_account`); 302 to Google |
| `/api/google/auth/callback` | GET | Exchange code → fetch userinfo email → save `<email>.json` (+ mirror primary) → 302 back to Settings→Google with status |
| `/api/google/accounts/{email}` | DELETE | Revoke token at Google + delete file |

Scopes = skill scopes + `openid email https://www.googleapis.com/auth/userinfo.email`
(needed to identify the account). State param is CSRF-signed + short-TTL.

### 3.4 Frontend
- **Settings → Google** page: list connected accounts (email, scopes summary, remove
  button), **"Connect account"** button → full-page nav to `/api/google/auth/start`
  (Google consent → callback → back to this page with a success toast). Re-clicking adds
  another account (`prompt=select_account`).
- **Home card:** "Connect Google" copy now links to Settings → Google (no more "do it on
  the box over CLI" language).
- `api.ts`: `listGoogleAccounts()`, `removeGoogleAccount(email)`, `googleAuthStartUrl()`.

### 3.5 Brief aggregation
`google_brief.build_brief()` upgraded to merge Gmail "top of mind" + Calendar across
`all_credentials()`, tagging each item with its source account; `connected` = any
account present.

## 4. Phases
1. **OAuth client (operator)** — create GCP Web client, hand off `client_secret.json`. *(gating)*
2. **Backend connect flow** — `google_accounts.py` + the 4 endpoints + state/CSRF; place client secret; verify a real connect end-to-end with one account.
3. **Frontend** — Settings→Google page + Home card link + `api.ts`.
4. **Multi-account brief** — aggregate Gmail/Calendar across accounts.
5. **(later)** Calendar/Drive pages consume connected accounts; People import.

Exit criteria per phase gated on the prior (operator can connect ≥2 accounts from the
dashboard and see both reflected in the brief).

## 5. Risks
- **Caddy basic-auth on the funnel callback:** the callback runs in the operator's
  already-authenticated browser, so the cached basic-auth header rides along; if it
  500s, exempt `/api/google/auth/callback` in the Caddyfile. (Tunnel path has no
  basic-auth.)
- **Unverified scopes / "App not verified" screen:** External consent screen in *Testing*
  mode → operator must add each Gmail address as a **test user**; the consent screen
  shows an "unverified app" warning (expected for a personal appliance — click Advanced →
  continue). Refresh tokens for Testing-mode apps can expire in 7 days unless the app is
  published; if that bites, publish the consent screen (no Google review needed for
  personal use without sensitive-scope verification — but gmail/drive ARE sensitive, so
  long-term may need verification or staying in Testing with periodic re-auth). Flagged.
- **Token security:** tokens are full Gmail/Drive read-write. Files are `chmod 600` under
  `$HERMES_HOME`; box is single-tenant. Acceptable for the appliance threat model.

## 6. Operator action — create the Google Cloud OAuth Web client
(Exact steps are delivered alongside this PRD; the two redirect URIs in §3.1 must be
registered verbatim, and each Gmail account you want to connect added as a Test user.)
