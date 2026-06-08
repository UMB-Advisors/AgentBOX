# Google Ingestion Unification — one dashboard connection feeds MailBOX ingestion

**Version:** 0.1.0
**Date:** 2026-06-08
**Status:** Draft (spec-first; no code yet) — **D1 resolved 2026-06-08: SoT = Hermes store**
**Owner:** Dustin
**Source:** Live diagnosis of agentbox2 "emails aren't loading" (this conversation) + **MBOX-464**
**Related:** `google-connect-prd.v0.1.0.md`, `unified-inbox-prd.v0.1.0.md`, memory `agentbox-google-single-source-of-truth`

---

## TL;DR

Today AgentBOX has **three independent Google token stores**. An operator who connects Google once (via the dashboard's **Settings → Google**) lights up Calendar/Drive/account-selector — but **email ingestion stays dark**, because the MailBOX ingestion pipeline (n8n) authenticates with a *separate, manually-created* `gmailOAuth2` credential that the dashboard connection never populates. On agentbox2 that n8n credential simply doesn't exist, so `inbox_messages = 0` and the Incoming Messages tab is empty (MBOX-464).

This spec makes the **single dashboard Google connection the source of truth (SoT)** for all Gmail access, so ingestion authenticates from the same token the operator already granted — connect once, everything works. No second OAuth, no hand-built n8n credential.

---

## Problem (evidence from agentbox2, 2026-06-08)

Three stores, none of which talk to each other:

| # | Store | Location | Feeds | State on agentbox2 |
|---|---|---|---|---|
| 1 | **Hermes** | `~/.hermes/google_token.json`, `~/.hermes/google_accounts/<email>.json` | Account selector, Calendar, Drive (Hermes `:9119` surfaces) | ✅ connected (`consultingfutures@gmail.com`) |
| 2 | **MailBOX dashboard** | Postgres `mailbox.oauth_tokens` (migration 031/033) | MailBOX dashboard Gmail features (voice backfill, etc.) | ❌ empty |
| 3 | **n8n** | n8n `credentials_entity` → `gmailOAuth2` (e.g. id `vEz5mz0uaAtlK8yz`) | **Email ingestion** (the `MailBOX` workflow's Gmail node) | ❌ missing credential |

**Ingestion flow today** (`mailbox/n8n/workflows/MailBOX.json`):

```
scheduleTrigger (every 5 min)
  → Cooldown Check (httpRequest → dashboard)
  → Get many messages  [n8n-nodes-base.gmail, cred: gmailOAuth2 #vEz5mz0uaAtlK8yz]   ← the coupling point
  → Extract Fields (set)
  → Insert Inbox (httpRequest → POST /api/internal/inbox-messages)
  → Run Classify Sub → … → Cycle Complete
```

The **only** Gmail-authenticated step is the `Get many messages` node, bound to an n8n-native credential. The shipped multi-account runbook (`mailbox/docs/runbook-multi-account-ingestion-v0_1-2026-05-28.md`) makes this explicit and intentional: *"Each account gets its own `gmailOAuth2` credential in n8n … n8n editor → Credentials → New → Gmail OAuth2."* Steps 3–4 are documented as manual on-box work because "Google OAuth consent can't be done from CI."

Net: the operator's dashboard connection and the ingestion credential are **different grants in different stores**. That is the defect this spec closes.

---

## Goal & non-goals

**Goal:** Connecting a Google account in the dashboard (one consent) is sufficient for that account's mail to be ingested. n8n holds **no** standalone Gmail credential.

**Non-goals (this version):**
- Migrating Calendar/Drive off the Hermes store (they already work; leave them).
- Replacing n8n as the ingestion orchestrator (keep the schedule/classify/draft topology).
- Pub/Sub push ingestion (today's box polls every 5 min; keep polling for V1).
- Multi-tenant shared GCP client (STAQPRO-197; future).

---

## Source-of-truth decision

**SoT = the dashboard's Google connection, backed by the Hermes store (#1).** **Decided 2026-06-08.**

Rationale: AgentBOX is **absorbing MailBOX into Hermes** (decision 2026-06-06; Hermes is the unified dashboard, `mailbox/` is vendored and on a deprecation path). Investing the token authority in `mailbox.oauth_tokens` (#2) would build on the layer being retired. The Hermes store already holds the **live** connection the operator just made (`~/.hermes/google_accounts/<email>.json`) and already powers Calendar/Drive/selector — making it SoT means **the connect the operator already does is the whole story**, and it ages with the platform rather than against it.

The token authority (Hermes, `:9119`) owns the long-lived refresh token + refresh logic and exposes **per-account, short-lived access tokens** to consumers (n8n ingestion, and later anything else). `mailbox.oauth_tokens` is **not** used by this design and can be retired with the rest of MailBOX.

---

## Design options

### Option A — Sync the token into the n8n credential store
On dashboard connect, write/update an n8n `gmailOAuth2` credential row (encrypted with `N8N_ENCRYPTION_KEY`) from the dashboard's refresh token.
- ➖ Brittle: must reproduce n8n's credential cipher + schema; n8n caches credentials, and (per the runbook) SQL writes don't reach runtime without a restart. Re-couples to store #3 instead of removing it.
- **Rejected** as the primary path (keeps three stores, just auto-fills one).

### Option B — Dashboard mints access tokens; n8n calls Gmail over HTTP (recommended)
Replace the `Get many messages` **gmail** node with an **httpRequest** node that:
1. `GET /api/internal/google/access-token?account_email=<A>` (new dashboard internal endpoint) → returns a fresh, scope-limited **access token** minted from the stored refresh token.
2. Calls Gmail REST (`users.messages.list` / `get`) with that bearer token.

- ➕ n8n holds **zero** Google credentials — store #3 is eliminated. Dashboard is the single token authority. Per-account by passing `account_email` (matches the existing fan-out contract: Insert-Inbox already stamps `account_email`).
- ➕ Reuses existing refresh logic + the existing internal-API trust boundary (loopback / shared secret).
- ➖ Workflow JSON change (one node swap per account branch) + one new internal endpoint. Token-minting endpoint must be locked to localhost/internal only.
- **Recommended.**

### Option C — Move the Gmail fetch into the dashboard entirely
Dashboard fetches Gmail and pushes envelopes to `/api/internal/inbox-messages`; n8n triggers the dashboard fetch instead of fetching itself.
- ➕ Strongest separation (all Google I/O in one service).
- ➖ Larger refactor; moves the polling/dedup/cooldown logic out of n8n. Defer to a later version.

---

## Recommended approach: Option B, phased

**Phase 1 — Token authority endpoint (on Hermes, `:9119`)**
- New internal endpoint `GET /api/internal/google/access-token?account_email=` on the **Hermes** service, reading the refresh token from `~/.hermes/google_accounts/<email>.json`, refreshing as needed, returning `{access_token, expires_at}`. Internal-only (loopback bind + shared-secret header; never exposed via the funnel/Caddy).
- Reuse Hermes' existing Google token-refresh path that already serves Calendar/Drive (same store, same client `570395642506-…`).

**Phase 2 — Account ↔ inbox mapping (connect already writes the SoT)**
- The dashboard **Settings → Google** connect *already* persists the Hermes-store refresh token (verified live: `consultingfutures@gmail.com.json` written on connect), so no new write path is needed. Confirm scopes cover ingestion (`gmail.readonly` present; `gmail.modify` for mark-read — both already in the consent set).
- Ensure each connected `account_email` maps to a `mailbox.accounts` row (`email_address`) so ingestion can stamp `account_email` on insert.

**Phase 3 — Re-point n8n ingestion**
- In `MailBOX.json`, replace the `Get many messages` gmail node with the httpRequest pattern (token fetch from the Hermes endpoint → Gmail REST). One branch per connected account (`account_email`), preserving the existing serial fan-out topology from the runbook.
- Remove the standalone n8n `gmailOAuth2` credential dependency. Publish + `docker compose restart n8n`; all four `MailBOX*` workflows `active=true`.
- **Reachability:** n8n (container) → Hermes (host `:9119`) — reach via Docker host-gateway (`host.docker.internal` / `extra_hosts`) with the shared secret, or front the token endpoint through the existing `mailbox-dashboard` `/api/internal/*` proxy that n8n already calls (decide in D3).

**Phase 4 — Verify & document**
- Connect a fresh account in the dashboard only → within one poll cycle (≤5 min) `inbox_messages` for that `account_email` increments; drafts appear in Incoming Messages. No n8n editor step performed.
- Update the multi-account runbook to replace "create a per-account n8n Gmail credential" with "connect the account in the dashboard."

---

## Security considerations

- **Per-account isolation** (hard requirement from the runbook): the access-token endpoint must scope strictly by `account_email`; one account's request must never return another's token. No shared credential.
- **Token-minting endpoint is internal-only**: loopback bind + shared-secret/internal-auth header; assert it is **not** routed by Caddy/the Tailscale funnel.
- **Least scope for ingestion**: ingestion needs only `gmail.readonly` (+ `gmail.modify` if marking read). Mint access tokens limited to what the cycle needs.
- **No secret readback**: endpoint returns short-lived access tokens only, never the refresh token.

---

## Open questions / decisions

- **D1 — SoT store:** ✅ **RESOLVED (2026-06-08): Hermes store** (`~/.hermes/google_accounts`). MailBOX is being absorbed into Hermes, so `mailbox.oauth_tokens` is on the deprecation path; the Hermes store already holds the live connection + serves Calendar/Drive. `mailbox.oauth_tokens` is unused by this design.
- **D2 — Service that hosts the token endpoint:** ✅ **RESOLVED: Hermes (`:9119`)** — it owns the SoT store and the existing refresh path. (Follows from D1.)
- **D3 — n8n → token endpoint reachability + auth:** **OPEN.** n8n is a container; Hermes is on the host. Either (a) n8n calls `http://host.docker.internal:9119/api/internal/...` via Docker host-gateway + shared secret, or (b) front the Hermes token endpoint behind the `mailbox-dashboard` `/api/internal/*` proxy that n8n already reaches/trusts. Decide before Phase 3.
- **D4 — Backfill vs go-forward:** does connecting also trigger a one-time historical pull, or forward-only? (Ties to MBOX-236/238 Sent-backfill.)

## Acceptance criteria

- [ ] Operator connects a Google account in **Settings → Google** and performs **no** n8n editor work.
- [ ] Within ≤5 min, that account's mail lands in `mailbox.inbox_messages` (tagged `account_email`) and drafts surface in Incoming Messages.
- [ ] n8n `credentials_entity` contains **no** `gmailOAuth2` credential; the `MailBOX` Gmail step authenticates via the dashboard token authority.
- [ ] Per-account isolation verified (account A's cycle cannot fetch account B's mail).
- [ ] Token-minting endpoint unreachable from the funnel.
- [ ] Runbook updated; MBOX-464 closed.

## Appendix — live evidence (agentbox2, read-only, 2026-06-08)

- `mailbox.oauth_tokens` → 0 rows; `mailbox.inbox_messages` → 0; `drafts` → 0 (all statuses).
- n8n `credentials_entity` → empty; `MailBOX`/`-Classify`/`-Draft`/`-Send` all `active=f`.
- `MailBOX` Gmail node binds `gmailOAuth2` id `vEz5mz0uaAtlK8yz` ("Gmail account") — credential absent.
- Hermes store updated on connect: `~/.hermes/google_accounts/consultingfutures@gmail.com.json` (mtime 23:32).
- `:9119` served by host `hermes` process; `/dashboard/*` proxied to the `mailbox-dashboard` container; ingestion polls every 5 min (no Pub/Sub).
