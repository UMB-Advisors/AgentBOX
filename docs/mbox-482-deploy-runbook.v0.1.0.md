# MBOX-482 deploy runbook — n8n ingestion + send for M365/IMAP

**Version:** 0.1.0
**Date:** 2026-06-10
**Issue:** MBOX-482 (P1 IMAP cred-sync + P2 M365 Graph token-as-data). Parent epic MBOX-469.
**Spec:** `docs/n8n-credential-unification-prd.addendum-01.md`

## TL;DR

This PR ships the **artifacts** (dashboard routes, n8n workflows, box tooling,
the Hermes→dashboard registration bridge). Box-side **activation** (workflow
import, n8n credential sync, container restart) is the operator's job — the
exact commands are below. Nothing here is auto-applied to a running box; the
live Gmail flow on agentbox2 is byte-untouched.

## What changed (artifacts in this PR)

| Piece | Path | Role |
|---|---|---|
| Registration bridge (dashboard) | `mailbox/dashboard/app/api/internal/accounts/{register,deregister}/route.ts` | Hermes connect/disconnect → `mailbox.accounts` projection (internal-token-gated) |
| Registration bridge (Hermes) | `hermes_cli/dashboard_bridge.py` + connect/delete route wiring in `web_server.py` | best-effort httpx push on connect/re-auth/disconnect |
| Graph minter | `mailbox/dashboard/app/api/internal/graph/access-token/route.ts` | app-only Graph bearer per account (token-as-data) |
| Graph workflows | `mailbox/n8n/workflows/MailBOX-Graph.json`, `MailBOX-Graph-Send.json` | M365 ingest + send (httpRequest only) |
| IMAP cred materializer | `mailbox/dashboard/app/api/internal/imap-credentials/route.ts` | returns n8n `imap`+`smtp` cred payloads (decrypted app-password) |
| IMAP cred sync | `bin/mbox-imap-cred-sync.sh` | `docker exec n8n import:credentials` (create/update/delete) |
| IMAP clone generator | `bin/mbox-imap-clone.sh` | per-account `MailBOX-Imap{,-Send}` clones |

## Pre-flight (all boxes)

1. **`HERMES_INTERNAL_TOKEN` parity.** The four new internal routes
   (`accounts/register`, `accounts/deregister`, `graph/access-token`,
   `imap-credentials`) all fail-closed on this shared secret. Confirm it is set
   identically on the dashboard service AND in n8n's env (already required by the
   Gmail minter — same value):
   ```bash
   ssh <box> 'cd ~/mailbox && grep -c HERMES_INTERNAL_TOKEN .env'   # expect >=1
   ```
2. **`MAILBOX_OAUTH_TOKEN_KEY` set on the dashboard.** The Graph minter +
   imap-credentials route decrypt `provider_secret_enc` with it; the register
   bridge encrypts with it. Already required by the Google connect.
3. **Deploy the dashboard build** (new routes) the normal way (merge → CI
   deployer, or `bin/deploy-dashboard.sh` break-glass). The mailbox-stack
   dashboard container also needs a rebuild if it's the proxied `/dashboard/*`:
   ```bash
   ssh <box> 'cd ~/mailbox && docker compose build mailbox-dashboard && docker compose up -d mailbox-dashboard'
   ```

## P2 — M365 Graph activation

1. **Connect an M365 mailbox** in the Hermes dashboard (Settings → mail accounts
   → Microsoft 365). The registration bridge auto-projects it into
   `mailbox.accounts` (provider=`microsoft`, `provider_secret_enc` set). Verify:
   ```bash
   ssh <box> "docker exec mailbox-postgres-1 psql -U \$POSTGRES_USER -d \$POSTGRES_DB -c \"SELECT id,email_address,provider,(provider_secret_enc IS NOT NULL) AS has_secret FROM mailbox.accounts WHERE provider='microsoft';\""
   ```
2. **Smoke the minter** from inside the n8n container (proves token-as-data end
   to end):
   ```bash
   ssh <box> "docker exec mailbox-n8n-1 wget -qO- --header='X-Hermes-Internal-Token: '\"\$HERMES_INTERNAL_TOKEN\" 'http://mailbox-dashboard:3001/dashboard/api/internal/graph/access-token?account_email=<m365-email>'"
   # expect {"access_token":"...","expires_at":"..."}
   ```
3. **Import the Graph workflows** (mirrors `scripts/n8n-import-workflows.sh`).
   Before importing `MailBOX-Graph.json`, set the `Account Email` node's value to
   the connected M365 address (or generate a per-account copy the same way the
   IMAP clones are made):
   ```bash
   for wf in MailBOX-Graph.json MailBOX-Graph-Send.json; do
     scp mailbox/n8n/workflows/$wf <box>:/tmp/$wf
     ssh <box> "docker cp /tmp/$wf mailbox-n8n-1:/tmp/$wf && \
       docker exec mailbox-n8n-1 n8n import:workflow --input=/tmp/$wf && \
       docker exec mailbox-n8n-1 rm -f /tmp/$wf"
   done
   ```
4. **Re-point the Postgres credential id** in `MailBOX-Graph-Send.json` if this
   box's `MailBox Postgres` cred id differs from `JFX4tvrffvKnTouV` (open the
   node in the n8n UI and re-link, or sed + re-import).
5. **Wire the send webhook.** Add `N8N_GRAPH_WEBHOOK_URL` to the dashboard env
   (`http://n8n:5678/webhook/mailbox-graph-send`) and route `provider='microsoft'`
   drafts to it in `dashboard/lib/n8n.ts` (same switch that picks `mailbox-send`
   vs `mailbox-imap-send` by `accounts.provider`). **This dashboard wiring is a
   small follow-up — see "Known gaps" — the send workflow itself is ready.**
6. **Activate + restart:**
   ```bash
   ssh <box> "docker exec mailbox-n8n-1 n8n update:workflow --active=true --id=MailBoxGraph00001 && \
              docker exec mailbox-n8n-1 n8n update:workflow --active=true --id=mailbox-graph-send && \
              cd ~/mailbox && docker compose restart n8n"
   ```
7. **Gate check:** `mailbox-n8n-verify` only checks the four core workflows; the
   Graph pair is verified by a live ingest cycle (inbox row lands within 5 min).

## P1 — IMAP/SMTP activation

1. **Connect an IMAP mailbox** in the Hermes dashboard. The bridge projects it
   (provider=`imap`). Verify as in P2 step 1 (`WHERE provider='imap'`).
2. **Sync the n8n credential** (decrypts the app-password dashboard-side, imports
   into n8n). Run from a dev machine with box SSH + the shared token in env:
   ```bash
   SSH_HOST=<box> HERMES_INTERNAL_TOKEN=<token> \
     bin/mbox-imap-cred-sync.sh <imap-email>
   # prints imap=mbximap<id> smtp=mbxsmtp<id>
   ```
   On re-auth, re-run the same command (overwrites). On disconnect:
   `bin/mbox-imap-cred-sync.sh --delete <imap-email>`.
3. **Generate the per-account workflow clones** with the cred ids the previous
   step printed:
   ```bash
   bin/mbox-imap-clone.sh <imap-email> mbximap<id> mbxsmtp<id>
   # writes ./.mbox-imap-clones/MailBOX-Imap-acct<id>.json + -Send-acct<id>.json
   ```
4. **Import the clones + restart** (same import pattern as P2 step 3, then):
   ```bash
   ssh <box> "docker exec mailbox-n8n-1 n8n update:workflow --active=true --id=MlbxImapIngest<00id> && \
              docker exec mailbox-n8n-1 n8n update:workflow --active=true --id=MlbxImapSend<00id> && \
              cd ~/mailbox && docker compose restart n8n"
   ```

## Rollback

- Workflows: `docker exec mailbox-n8n-1 n8n update:workflow --active=false --id=<id>` + restart n8n.
- IMAP creds: `bin/mbox-imap-cred-sync.sh --delete <email>`.
- The dashboard routes are additive; reverting the build removes them. The live
  Gmail `MailBOX.json` flow is unaffected by anything here.

## Known gaps (carried into follow-ups)

- **`dashboard/lib/n8n.ts` send routing for `microsoft`** is not wired in this PR
  (the `N8N_GRAPH_WEBHOOK_URL` switch). The Graph send workflow is ready; the
  dashboard just doesn't pick it yet. Gmail + IMAP routing is unchanged.
- **No live M365/IMAP account** was available to e2e-verify ingest/send in this
  change — the minter, normalize, and workflow topologies are validated by unit
  tests + JSON validation + the Gmail reference pattern, not a real round-trip.
- **Multi-IMAP-account send webhook** still shares the `mailbox-imap-send` path;
  >1 IMAP account on one box needs per-account webhook paths (noted by the clone
  generator). P2 Graph reply uses a flat `Re:` send (no RFC In-Reply-To headers),
  the same residual as IMAP send.
- **P0.5 (Gmail send → HTTP token-as-data) was SKIPPED** as too risky for the
  live customer-#1 send path (MIME/threading rewrite, no test rig here). Tracked
  separately.
