# n8n credential unification — dashboard connect feeds n8n (Gmail + M365 + IMAP)

**Version:** 0.1.0
**Date:** 2026-06-09
**Author:** Dustin (via Claude Code)
**Status:** Draft for review
**Issues:** MBOX-466 (Gmail unification) + MBOX-482 (M365/IMAP) — designed together here. Parent epic MBOX-469.
**Decisions locked (2026-06-09):** credential model **A — push-to-n8n-credential**; **unified** across providers (one model, not per-provider one-offs).

## TL;DR

A mailbox connected in the dashboard (Gmail via Google connect; M365/IMAP via the MBOX-468 onboarding) must **automatically flow through n8n** — inbound polled → classified → drafted → approved → sent — with **no manual credential re-linking**. Today that link is **hand-made in the n8n UI per appliance**, which is why agentbox2 never ingested (MBOX-464). This PRD defines one mechanism: on connect/disconnect/re-auth, the **dashboard (the single source of truth) syncs a per-account n8n credential** via the n8n CLI, and the MailBOX workflows consume it.

## Problem / current state

- **Credentials are manually re-linked.** `mailbox/scripts/n8n-import-workflows.sh` literally instructs: *"open the credential-bearing nodes (Postgres, Gmail OAuth2) and re-link to the appliance-local credential records… Re-link credentials in the n8n UI for each imported workflow."* Credential IDs differ per box.
- **n8n auths via n8n-stored credentials**, not by reading `mailbox.accounts`/`provider_config` at runtime. The dashboard's connected-account stores (Google `oauth_tokens`; MBOX-468 `$HERMES_HOME/mail_accounts/*.json`) are **disconnected from n8n**.
- **3+ token stores** today (Google connect tokens, n8n's own gmailOAuth2 cred, the MBOX-468 file store) — the `google-single-source-of-truth` problem.
- **Provider coverage:** Gmail workflows exist (`MailBOX.json`, `MailBOX-Send.json`); **IMAP workflows exist** (`MailBOX-Imap.json`, `MailBOX-Imap-Send.json`); **M365/Graph has none** (net-new).

## Decision

**Model A — push-to-n8n-credential, unified.** The dashboard connected-account store is the **single master SoT**. On every connect / disconnect / re-auth, the dashboard **syncs an n8n credential** for that account. Workflows consume per-account credentials. The dashboard remains the only place a human connects an account; n8n is downstream and never hand-edited.

Rejected: **B (decrypt-in-workflow)** — sprawls the encryption key into n8n, weakens the MBOX-468 at-rest posture. **C (dashboard-as-proxy)** — purest single-store but rewrites how n8n does mail I/O; revisit only if credential-sync proves insufficient.

## Mechanism — credential sync

- **Transport:** reuse the existing `docker exec <n8n> n8n import:credentials --input=<file>` path (mirrors how `import:workflow` already runs in `n8n-import-workflows.sh`). No dependency on the n8n public REST API. (Public API is a fallback if the CLI proves limiting.)
- **Trigger:** the dashboard connect routes —
  - Gmail: the existing Google connect (`oauth_tokens`).
  - M365/IMAP: the MBOX-468 routes (`/api/accounts/microsoft`, `/api/accounts/imap`) → on `mode:'connect'`, after the green probe + persist, emit a credential-sync step.
- **Credential payload per provider:**
  - **Gmail** → n8n `gmailOAuth2`/OAuth2 credential built from the dashboard's stored Google token (client + refresh token).
  - **M365** → n8n OAuth2 (client-credentials) **or** Header-Auth credential carrying an app-only bearer; tenant/client/secret from the `mail_accounts` record (decrypted dashboard-side via `HERMES_MAIL_SECRET_KEY`).
  - **IMAP** → n8n `imap` + `smtp` credentials (host/port/user/app-password) from the `mail_accounts` record.
- **At rest:** n8n encrypts credential values with `N8N_ENCRYPTION_KEY`. The dashboard decrypts its own copy only at sync time; raw secrets never land in workflow JSON.
- **Lifecycle:** create on connect → update on re-auth / token refresh → delete on disconnect. Idempotent (keyed by account id).

## Central design question — multi-account credential binding

n8n nodes bind **one** credential at design time, but the box serves **N accounts** (MBOX-348 made `account_id` first-class). Resolve in the design phase:

| Option | Fit | Notes |
|---|---|---|
| **(b) HTTP Request + token-as-data** *(recommended for Gmail/Graph)* | OAuth/HTTP providers | Workflow loops accounts; a dashboard endpoint returns a short-lived access token per account; the HTTP Request node uses it. Most flexible; no per-account workflow sprawl. |
| **(a) Per-account workflow instances** | any provider | Dashboard clones the base workflow + binds the account's credential on connect. Simple per-account, but workflow sprawl. |
| **(c) Expression-selected credential id** | limited | Some n8n nodes accept a credential id by expression; coverage is inconsistent — verify per node type. |

Recommendation: **(b)** for Gmail + M365 (both HTTP/Graph); for **IMAP/SMTP** (native n8n nodes that can't take token-as-data), use **(a)** per-account or the credential-id expression if the IMAP node supports it.

## Per-provider work

- **Gmail (MBOX-466):** replace the manual `gmailOAuth2` re-link with dashboard→n8n credential sync from the Google connect. Resolves MBOX-464 (the missing-cred ingestion gap). Wire `MailBOX.json` / `MailBOX-Send.json` to the synced per-account creds.
- **IMAP (existing workflows):** sync `imap`+`smtp` creds from `mail_accounts`; wire `MailBOX-Imap.json` / `MailBOX-Imap-Send.json` to consume them per account.
- **M365 (net-new):** build `MailBOX-Graph.json` (ingest: Graph `messages` poll → `inbox_messages`) + `MailBOX-Graph-Send.json` (Graph send), mirroring the Gmail topology; auth via the synced M365 credential.

All three converge on the shared classify/draft/approve/send pipeline (`MailBOX-Classify`, `MailBOX-Draft`, `MailBOX-MsgAction`) unchanged.

## Phasing

- **P0 — Sync mechanism + Gmail.** Build the dashboard credential-sync step (CLI import wrapper) + Gmail path. Closes MBOX-464/466. Highest value (Gmail is the live product).
- **P1 — IMAP.** Sync creds → wire the existing IMAP workflows. Smallest add (workflows exist).
- **P2 — M365.** New Graph ingest/send workflows + M365 cred sync. Completes MBOX-482.

## Security

- Dashboard store stays the master; n8n holds derived, `N8N_ENCRYPTION_KEY`-encrypted copies.
- No plaintext credentials in workflow JSON or logs.
- M365 app-only secret grants standing whole-mailbox access — disconnect must delete the n8n credential too (not just the dashboard record).
- Threat-model the credential-sync step (it decrypts dashboard secrets to push them) — security review before P0 ships.

## Open questions

1. **Multi-account binding** — confirm (b) token-as-data works for the Gmail/Graph HTTP nodes on this n8n version; confirm the IMAP node's credential-expression support for (c) vs falling back to (a).
2. **Token refresh** — Gmail uses a refresh token (sync on refresh); M365 app-only has no refresh (re-mint per poll; cred just holds client_credentials). Define the refresh→resync trigger.
3. **Reconcile the 3 token stores** — does the dashboard `mail_accounts` + Google `oauth_tokens` collapse into one store, or stay separate masters that both sync to n8n? (`google-single-source-of-truth`.)
4. **CLI vs public API** — confirm `n8n import:credentials` round-trips a programmatically-built credential; else enable the public API + key.
5. **Per-customer scale** — credential naming/cleanup so re-installs and OTAs don't orphan n8n credentials.

## Non-goals

- Rewriting the classify/draft/send pipeline (unchanged).
- Dashboard-as-proxy mail I/O (Model C) unless sync proves insufficient.
- New provider types beyond Gmail / M365 / IMAP.
