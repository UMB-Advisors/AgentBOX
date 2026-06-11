# Addendum 01 — n8n credential unification PRD

**Extends:** `n8n-credential-unification-prd.v0.1.0.md`
**Date:** 2026-06-10
**Author:** Dustin (via Claude Code)
**Status:** Draft for review
**Issues:** MBOX-466 (Gmail), MBOX-482 (M365/IMAP), MBOX-464 (ingestion gap). Parent epic MBOX-469.
**Purpose:** Resolve the PRD's two flagged design questions (open questions #1 multi-account binding, #3 token-store reconciliation) against the **actual code on `main`**, and correct a premise the v0.1.0 framing got wrong.

> Addendum, not rewrite. The v0.1.0 decision (Model A — push-to-n8n-credential, unified) stands **for IMAP/SMTP**. What changes is its *scope*: it does **not** apply to the Gmail or M365 paths, which are HTTP and already use (or should use) token-as-data. See §1.

---

> ⚠️ **CORRECTION (2026-06-10):** §3's "make `oauth_tokens` the single Google master" decision is **reversed** — it targeted the **deprecated** MailBox Next.js dashboard's store. The live box and the go-forward **Hermes dashboard** use the Hermes host store (`~/.hermes/google_accounts/*.json`); `oauth_tokens` belongs to the app being retired (build-target = hermes, 2026-06-09). The P0 re-point (PR #51) was reverted (PR #60). **Canonical Google master = the Hermes host store.** See the corrected §3 Decision.

## TL;DR

Code investigation (2026-06-10, against `main`) overturns the PRD's working assumption that all three providers need a synced n8n credential:

1. **Gmail ingest already uses token-as-data**, not an n8n credential. `MailBOX.json` mints a per-request bearer from the dashboard (`/api/internal/google/access-token`) and calls the Gmail REST API via HTTP Request nodes. There is **no `gmailOAuth2` credential in the ingest path** to sync. P0's real work is making that token-authority path work end-to-end and collapsing two competing Google token stores — **not** building a credential-sync mechanism.
2. **n8n 2.14.2 does not support expression-selected credentials.** Multi-account binding resolves by node type: **token-as-data (b)** for everything HTTP (Gmail, M365 Graph); **per-account workflow clones (a)** for the native IMAP/SMTP nodes. Option (c) is dead on this version.
3. **The real MBOX-464 root cause is a split Google master**, not a missing n8n credential. The token-minting endpoint reads a *plaintext file store* (`~/.hermes/google_accounts/*.json`) while the dashboard Google **connect** writes an *encrypted Postgres table* (`mailbox.oauth_tokens`). Connect in the dashboard, and the file store the minter reads stays empty → no token → no ingestion.

**Decision (this addendum):** make `mailbox.oauth_tokens` the **single Google master**; point the access-token minter at it; deprecate the plaintext Hermes file store for this path. Re-scope phasing accordingly (§4).

---

## 1. Premise correction — Model A applies to IMAP/SMTP only

The v0.1.0 PRD frames all three providers as "on connect, the dashboard syncs a per-account n8n credential." That is only correct for IMAP/SMTP. Evidence from `main`:

| Path | Workflow | Auth node type | How it binds | Needs an n8n credential? |
|---|---|---|---|---|
| Gmail **ingest** | `MailBOX.json` | `httpRequest` (`Get Gmail Token` → `Gmail List`/`Gmail Get`) | Bearer minted per-request from dashboard `/api/internal/google/access-token`; forwarded as `Authorization: Bearer {{ $('Get Gmail Token')... }}` | **No** — token-as-data, already live |
| Gmail **send** | `MailBOX-Send.json` | native `n8n-nodes-base.gmail` (`Gmail Reply`) | Fixed cred id `vEz5mz0uaAtlK8yz` | Today yes; should convert to HTTP + token-as-data (§2) |
| IMAP **ingest** | `MailBOX-Imap.json` | native `emailReadImap` | Fixed cred id placeholder `REPLACE_ON_IMPORT_IMAP` | **Yes** — native node, can't take token-as-data |
| SMTP **send** | `MailBOX-Imap-Send.json` | native `emailSend` | Fixed cred id placeholder `REPLACE_ON_IMPORT_SMTP` | **Yes** — native node |
| M365 **ingest/send** | net-new `MailBOX-Graph*` | `httpRequest` (Graph is HTTP) | Bearer minted dashboard-side | **No** — token-as-data like Gmail |

**Consequence:** "push-to-n8n-credential" (Model A) is the mechanism for **IMAP/SMTP only**. Gmail and M365 are token-as-data: the dashboard exposes a per-account access-token endpoint, the HTTP Request node consumes it. No n8n credential is created, synced, or deleted for the HTTP providers — which also removes them from the disconnect-cleanup and re-auth-resync surface entirely.

---

## 2. Resolves Open Question #1 — multi-account credential binding

**n8n is pinned at `2.14.2`** (`mailbox/docker-compose.yml:103`). On this version the `credentials` block of every node is **static** — it takes a fixed `{id, name}`, never an `={{expression}}`. **Option (c) "expression-selected credential id" is not viable** and is dropped.

The box serves N accounts (MBOX-348 made `account_id` first-class), so binding resolves by node type:

| Provider | Node | Binding | Rationale |
|---|---|---|---|
| **Gmail read** | `httpRequest` | **(b) token-as-data** | Already the live pattern. Multi-account = loop accounts, mint a token per account, feed the HTTP node. No per-account workflow sprawl, no n8n credential. |
| **Gmail send** | native `gmail` → **convert to `httpRequest`** | **(b) token-as-data** | Removes the last fixed `gmailOAuth2` cred; makes send symmetric with read; unlocks multi-account send without clones. |
| **M365 Graph** | `httpRequest` (net-new) | **(b) token-as-data** | Graph is HTTP. Dashboard mints an app-only bearer per account; no n8n credential. |
| **IMAP / SMTP** | native `emailReadImap` / `emailSend` | **(a) per-account workflow clone** | These native nodes can take neither token-as-data nor an expression cred on 2.14.2. Each account = a cloned workflow + its own synced `imap`/`smtp` credential. This is the **only** path where Model A credential-sync is actually exercised. |

**`account_id` threading reality (today):** account_id is resolved **dashboard-side**, not in n8n. Ingest workflows POST `account_email` to `/api/internal/inbox-messages`, which calls `resolveIngestAccountId({account_id, account_email})` and stamps the row (dedup key `(account_id, message_id)`, migration 025/033). So multi-account for the HTTP providers needs the workflow to *loop accounts and pass the right email/token* — no credential change in n8n. For IMAP it needs one cloned workflow per account with a hardcoded `account_email` and its own credential.

---

## 3. Resolves Open Question #3 — token-store reconciliation

There are **four** stores today (the PRD undercounted at three), and one it named — `$HERMES_HOME/mail_accounts/*.json` + `HERMES_MAIL_SECRET_KEY` — **does not exist in code**; treat it as a retired design artifact.

| # | Store | Holds | Encryption | Read by | Role |
|---|---|---|---|---|---|
| 1 | `mailbox.oauth_tokens` (Postgres) | Google refresh tokens, keyed `(provider, account_id)` | AES-256-GCM, `MAILBOX_OAUTH_TOKEN_KEY` | Dashboard Calendar/Drive/Contacts/Gmail surfaces | Dashboard's own Google master |
| 2 | `mailbox.accounts.provider_secret_enc` (Postgres) | IMAP app-passwords, M365 client secrets | AES-256-GCM, same key | IMAP backfill, send | Mail-transport secrets master (IMAP/M365) |
| 3 | `~/.hermes/google_accounts/*.json` (host FS) | Google refresh+access tokens, **plaintext**, keyed by `<email>` | **none** | `/api/internal/google/access-token` (what mints n8n's bearer) | Upstream Google token source, written by Hermes' own UI |
| 4 | n8n `credentials_entity` (Postgres) | Postgres conn cred + legacy unused `gmailOAuth2` | `N8N_ENCRYPTION_KEY` | n8n only | Downstream, sovereign to n8n |

**The fracture (and the actual MBOX-464 cause):** Google ingestion mints its bearer from store **#3** (the plaintext Hermes file), but the dashboard's Google **connect** flow writes store **#1** (`oauth_tokens`). Two masters, two write paths. If the operator connects Google in the dashboard but `~/.hermes/google_accounts/` is empty (or stale), the minter has nothing → no token → no ingestion. **That is MBOX-464** — not a missing n8n `gmailOAuth2` credential.

### Decision

> **CORRECTED DECISION (2026-06-10).** The original bullet below ("`oauth_tokens` becomes the single Google master") was aimed at the **wrong dashboard** and is reversed. There are **two** Google connect implementations: the **deprecated** MailBox Next.js dashboard (`mailbox-dashboard:3001`, writes `oauth_tokens`) and the **go-forward Hermes dashboard** (host `:9119`, writes `~/.hermes/google_accounts/*.json`). The live box (agentbox2) and the go-forward dashboard both use the **Hermes host store**; `oauth_tokens` is empty there and retires with the MailBox Next.js app (build-target = hermes, 2026-06-09). The minter already reads the Hermes store, so **no re-point is needed** — PR #51 attempted one and was reverted (PR #60).
>
> - **Canonical Google master = the Hermes host store** (the connect flow the go-forward dashboard owns). `oauth_tokens` is NOT made canonical.
> - **Hardening follow-up (non-blocking):** the Hermes store is *plaintext on disk* — track moving the canonical Google tokens into an at-rest-encrypted store owned by the go-forward dashboard, rather than blessing plaintext files permanently.
> - MBOX-464 ingestion was already resolved on agentbox2 (2026-06-10) by the multi-account workflow + RFC-2822 date-parse + draft-timeout fixes — not by any store re-point.

~~Original (SUPERSEDED):~~

- ~~**`mailbox.oauth_tokens` (#1) becomes the single Google master.** Re-point the `/api/internal/google/access-token` minter to read the refresh token from `oauth_tokens` and exchange it for a short-lived access token. **Deprecate the plaintext Hermes file store (#3) for this path.** (Fixes MBOX-464 structurally; kills a plaintext store; one-time backfill on first deploy.)~~
- **IMAP/M365 secrets (#2) need no reconciliation.** `provider_secret_enc` is a clean separate column keyed by `account_id`; it does not overlap Google. It feeds the per-account credential **sync** to n8n (#4) for IMAP/SMTP only.
- **n8n's store (#4) stays sovereign.** The dashboard never re-keys it. For HTTP providers it holds nothing; for IMAP/SMTP it holds the synced per-account creds.

**Net (corrected):** one Google master (the **Hermes host store**, #3), one mail-transport-secret master (#2, `provider_secret_enc`), n8n as a downstream consumer that holds credentials only for IMAP/SMTP. `oauth_tokens` (#1) retires with the MailBox Next.js dashboard; the plaintext Hermes store stays canonical pending the at-rest-encryption hardening follow-up.

---

## 4. Re-scoped phasing

Supersedes the v0.1.0 "Phasing" section.

- **P0 — Gmail end-to-end via the single Google master.** *(Closes MBOX-464 + MBOX-466.)* — **SUPERSEDED by the §3 correction.** MBOX-464 ingestion was already resolved on agentbox2 (2026-06-10); the canonical Google master is the **Hermes host store** the minter already reads, so there is **no `oauth_tokens` re-point** to do. Original P0 text kept for the record:
  - ~~Re-point `/api/internal/google/access-token` to read `mailbox.oauth_tokens`; one-time backfill from the Hermes file if present; deprecate file-store reads.~~
  - Confirm `MailBOX.json`'s token-as-data path runs on agentbox2 (env: `HERMES_INTERNAL_TOKEN` set; endpoint reachable from n8n).
  - **Verify what's actually deployed on agentbox2 first** (§5) — it may run an older `MailBOX.json` using the native gmail node, which changes the box-side fix.
  - No n8n credential-sync mechanism is built in P0. (This is the biggest change from v0.1.0, which front-loaded the sync mechanism here.)
- **P0.5 — Gmail send symmetry (optional, can fold into P0 or P1).** Convert `MailBOX-Send.json`'s native `gmail` node to HTTP + token-as-data, removing the last fixed `gmailOAuth2` cred and unlocking multi-account send.
- **P1 — IMAP via credential-sync.** This is where Model A is actually built: dashboard syncs per-account `imap`+`smtp` n8n credentials from `provider_secret_enc` via `n8n import:credentials`; clone `MailBOX-Imap*` per account (binding option (a)). Lifecycle: create on connect / update on re-auth / delete on disconnect.
- **P2 — M365 Graph (net-new), token-as-data.** Build `MailBOX-Graph.json` + `MailBOX-Graph-Send.json` mirroring the Gmail HTTP topology; dashboard mints app-only bearers per account from `provider_secret_enc`. No n8n credential. Completes MBOX-482.

---

## 5. Carry-over verification before P0 build

- **Deployed-workflow audit on agentbox2.** Memory flags agentbox2's dashboard as building from a stale pre-CRM snapshot. Confirm whether the box runs the token-as-data `MailBOX.json` (current `main`) or an older native-gmail-node version. If older: the box-side MBOX-464 fix is "deploy the token-as-data workflow + populate `oauth_tokens`," and only then does the §3 reconciliation apply cleanly.
- **`HERMES_INTERNAL_TOKEN` parity.** The minter endpoint gates on this shared secret (constant-time compare). Confirm it's set identically on the dashboard and in n8n's env on agentbox2.
- **Token-refresh trigger (was Open Q#2).** Gmail: refresh-token exchange happens at mint time from `oauth_tokens` — no separate resync needed once #3 is retired. M365 app-only: no refresh token; mint client-credentials per poll. Carry into the P1/P2 plans.
- **Credential naming/cleanup (was Open Q#5).** Only relevant to IMAP/SMTP in P1 (the only synced creds). Name n8n creds by `account_id` so re-installs/OTAs don't orphan them; delete on disconnect.

---

## 6. What this addendum changes vs v0.1.0

| v0.1.0 said | This addendum says |
|---|---|
| All three providers sync a per-account n8n credential (Model A). | Model A (credential-sync) applies to **IMAP/SMTP only**. Gmail + M365 are **token-as-data**, no n8n credential. |
| P0 = build the credential-sync mechanism + Gmail. | P0 = wire Gmail token-as-data end-to-end + **collapse the two Google stores**. Credential-sync moves to **P1 (IMAP)**. |
| 3 token stores; one is `$HERMES_HOME/mail_accounts/*.json`. | **4 stores**; that file path is a non-existent artifact. The real split is `oauth_tokens` (#1) vs the plaintext `~/.hermes/google_accounts/*.json` (#3). |
| MBOX-464 = missing n8n `gmailOAuth2` credential. | MBOX-464 = **split Google master**: minter reads #3, connect writes #1. |
| Multi-account binding: (b) recommended, (c) "verify per node." | (c) **dropped** — n8n 2.14.2 has no credential expressions. (b) for HTTP, **(a) mandatory** for native IMAP/SMTP. |

Unchanged from v0.1.0: Model A vs B/C decision (B/C still rejected); the shared classify/draft/approve/send pipeline stays untouched; transport for IMAP/SMTP creds is still `docker exec n8n import:credentials`.
