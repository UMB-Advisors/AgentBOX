# Runbook — Multi-Account Ingestion (MBOX-348 / MBOX-162 V1)

**Version:** v0.1.0 · **Date:** 2026-05-28 · **Status:** DRAFT (pending first on-box run)
**Scope:** V1 = ingestion only (account_id substrate + per-account Gmail fan-out). V2 (per-account persona/RAG isolation) and V3 (unified queue) are separate.

---

## TL;DR

1. Deploy the branch → migration `033` auto-applies via the `migrate` profile: creates `mailbox.accounts`, adds `account_id` to all 13 account-scoped tables, backfills every existing row to one seeded **default account**, reshapes the inbox/sent dedup keys and the `oauth_tokens` PK. **Non-breaking** — existing writers keep working (column DEFAULT → default account).
2. Run the one-shot Qdrant re-tag so existing vector points get `account_id`.
3. Rename the seeded default account if it landed on the sentinel email.
4. For each ADDITIONAL mailbox: create a per-account **Gmail OAuth credential** in n8n, add a serial Gmail-Get → Insert-Inbox branch that stamps that account's `account_email`, Publish + restart n8n, re-run the n8n-verify gate.
5. Verify acceptance checks. Promote DR-43 + DR-45 Candidate → Accepted on the PR.

The code (migration, account resolver, route changes, re-tag script) ships in the image. **Steps 3–4 are manual on-box work** (n8n editor + Google OAuth consent can't be done from CI).

---

## What the code already does (in this branch)

| Piece | File | Behavior |
|---|---|---|
| Schema | `dashboard/migrations/033-add-account-id-multi-account-v1-2026-05-28.sql` | accounts table + `account_id` FK x13 + backfill + dedup/PK reshapes |
| Account resolver | `dashboard/lib/queries-accounts.ts` | `resolveIngestAccountId({account_id?,account_email?})` → id, or reject |
| Inbound ingest | `app/api/internal/inbox-messages/route.ts` | dedup on `(account_id, message_id)`; accepts `account_id`/`account_email`; 400 on unknown |
| Outbound embed | `app/api/internal/embed/route.ts` | same resolution; tags the Qdrant point |
| Vector payload | `lib/rag/qdrant.ts` | `EmailPointPayload.account_id` (required) |
| Re-tag one-shot | `dashboard/scripts/retag-qdrant-account-id.ts` | fills `account_id` on pre-migration points (idempotent, forward-safe) |

**Contract:** if n8n sends **neither** `account_id` nor `account_email`, the message lands in the **default account** — i.e. today's single-account flow is byte-for-byte unchanged. The fan-out opts in by sending `account_email` (stable across appliances; ids differ per box).

---

## Deploy sequence (on M1)

> Pre-flight per root CLAUDE.md "Cross-session deploy check" — confirm M1's branch/SHA before pulling.

```bash
# 1. ship the branch
git push origin feat/mbox-348-multi-account-ingestion   # (or after merge to master)

# 2. on the box: pull + apply migration + rebuild
ssh mailbox1 'cd ~/mailbox && git pull && git submodule update --init \
  && docker compose --profile migrate run --rm mailbox-migrate \
  && docker compose up -d --build --remove-orphans'

# 3. Qdrant re-tag (existing points -> default account). Dry-run first.
ssh mailbox1 'docker exec -e DRY_RUN=1 mailbox-dashboard npx tsx scripts/retag-qdrant-account-id.ts'
ssh mailbox1 'docker exec mailbox-dashboard npx tsx scripts/retag-qdrant-account-id.ts'
```

The migration is idempotent at the runner level (tracked in `mailbox.migrations`); the re-tag is idempotent by the `is_empty` filter.

### Rename the default account (if it seeded the sentinel)

The migration sets the default account email from `onboarding.email_address`. If that was NULL it falls back to `primary@appliance.local`. Check and fix:

```bash
ssh mailbox1 "docker exec mailbox-postgres psql -U mailbox -c \
  \"SELECT id, email_address, is_default FROM mailbox.accounts;\""
# if sentinel:
ssh mailbox1 "docker exec mailbox-postgres psql -U mailbox -c \
  \"UPDATE mailbox.accounts SET email_address='founder@heronlabsinc.com', display_label='Heron (primary)' WHERE is_default;\""
```

---

## Adding a second (or third) mailbox — manual, on-box

Per **DR-44** this is single-operator (no RBAC) and **FR-4 / NC-31** caps at **3 accounts** in v1. Per **DR-45** accounts are processed **serially** (one active inference at a time → memory peak ≈ today's single-account peak; this is what de-risks S1).

### 1. Per-account Gmail OAuth credential (n8n)

Each account gets its **own** `gmailOAuth2` credential in n8n — never share one credential across accounts (a compromise of one account's tokens must not reach another's mail). Today's customer-#1 model is a per-customer GCP OAuth client (see dashboard CLAUDE.md "Credentials n8n owns"; shared Staqs client is STAQPRO-197, future).

1. n8n editor → Credentials → New → Gmail OAuth2. Authorize the second mailbox's Google account (expect the "unverified app" consent screen).
2. Note the credential name (e.g. `Gmail account — consulting`).

### 2. Fan-out topology (serial, credential-per-node)

n8n binds a Gmail credential **per node**, so we cannot loop one node over an account list switching credentials by data. The supported V1 topology is **one Gmail-Get branch per account, wired in series** off the single 5-min Schedule:

```
Schedule (5 min)
  └─ Cooldown/Bootstrap gates (unchanged)
       └─ [Account A] Gmail Get (cred A) → Insert Inbox (account_email = A) → Classify…
            └─ [Account B] Gmail Get (cred B) → Insert Inbox (account_email = B) → Classify…
                 └─ [Account C] …
```

- Duplicate the existing `Gmail Get → Insert Inbox (HTTP)` pair per account; set each `Gmail Get` to that account's credential.
- In each account's `Insert Inbox (HTTP)` node, add `account_email` to the JSON body (the literal mailbox address for that branch). That is the only new field; everything else in the STAQPRO-135 body is unchanged.
- Chain branches sequentially (B starts after A finishes) to honor DR-45 serial processing. Do **not** fan them out in parallel on T2.
- If you also embed outbound on send: the per-account `MailBOX-Send` path's `POST /api/internal/embed` node should likewise include `account_email`.

> Reminder (root CLAUDE.md): after editing, **Publish** the workflow in the editor and `docker compose restart n8n`. All four `MailBOX*` workflows must be `active=true`. SQL UPDATEs to `workflow_entity.nodes` do NOT reach runtime for webhook workflows.

### 3. Re-run the activation gate

```bash
ssh mailbox1 "cd ~/mailbox && docker compose --profile n8n-verify run --rm mailbox-n8n-verify"   # exit 0 = all 4 active
```

---

## Verification (acceptance criteria from MBOX-348)

```bash
# accounts seeded; second account present after step above
docker exec mailbox-postgres psql -U mailbox -c "SELECT id,email_address,is_default FROM mailbox.accounts ORDER BY id;"

# account_id NOT NULL + FK on every scoped table
docker exec mailbox-postgres psql -U mailbox -c \
  "SELECT table_name,is_nullable FROM information_schema.columns WHERE table_schema='mailbox' AND column_name='account_id' ORDER BY table_name;"

# dedup is per (account_id, message_id): the SAME Gmail message to two accounts coexists
docker exec mailbox-postgres psql -U mailbox -c \
  "SELECT account_id, count(*) FROM mailbox.inbox_messages GROUP BY 1 ORDER BY 1;"

# Qdrant points all carry account_id (0 untagged)
docker exec mailbox-dashboard npx tsx scripts/retag-qdrant-account-id.ts   # prints 'nothing to do' when clean
```

- [ ] Migration applied across all account-scoped tables, deterministic backfill, no data loss
- [ ] 2nd Gmail account connects + ingests, tagged with its `account_id`
- [ ] Same message to two accounts coexists (per-account dedup)
- [ ] Classify/draft runs serially across accounts within the poll cycle
- [ ] No regression to the existing single-account flow (no account fields sent → default account)

Optional: the confirmatory **S1 serialized-throughput** run on an idle window (low-risk under the serial model) — classify p95 < 5s while processing 3 accounts' mail per cycle.

---

## Rollback

Migration reversal (see the 033 header for the exact statements): drop the per-table FKs + `account_id` columns; restore `inbox_messages UNIQUE(message_id)` and the `sent_history` partial unique on `(message_id)`; restore `oauth_tokens PRIMARY KEY (provider)`; `DROP TABLE mailbox.accounts`. Backfill is non-destructive (original rows intact). The Qdrant re-tag adds a payload field old readers ignore → no Qdrant rollback needed. App code tolerates the rollback only if also reverted (the route requires the composite key); revert the branch alongside.

---

## DR promotion + follow-ups

- **DR-43** (account as first-class dimension): promote Candidate → **Accepted** — S2 PASS + this migration's dry-run (full 13-table scope) confirm clean deterministic backfill.
- **DR-45** (T2 serialized): promote Candidate → **Accepted** — fan-out is serial by topology; concurrent mode remains the T3/what-if case.
- **V2 follow-ups (not this issue):**
  - Qdrant point id is derived from `message_id` alone (`pointIdFromMessageId`); the same message in two accounts collides on one point. Per-account RAG isolation must key the point id on `(account_id, message_id)`.
  - `kb_documents` keeps its **global** `UNIQUE(sha256)` — a per-account KB needs `UNIQUE(account_id, sha256)`.
  - Denormalized `account_id` on `auto_send_audit` / `chat_messages` / `draft_feedback` must be kept consistent with their parent FK once those features go multi-account (column DEFAULT keeps them correct for the single operator until then).

---

## Addendum A — Google ingestion unification supersedes the per-account n8n credential (MBOX-466, 2026-06-08)

> **Status:** Supersedes the "Per-account Gmail OAuth credential (n8n)" steps above. Spec: `docs/google-ingestion-unification-prd.v0.1.0.md` (D1/D2/D3 resolved — SoT = Hermes store; token endpoint on the **mailbox-dashboard container** (mints from the read-only-mounted Hermes store — Hermes `:9119` is **not** called); transport = **container network** n8n → `mailbox-dashboard:3001`). Phasing tracked under **MBOX-466**. **Code state (this branch):** the dashboard token route (`mailbox/dashboard/app/api/internal/google/access-token/route.ts`), the `mailbox/docker-compose.yml` additions (n8n `HERMES_INTERNAL_TOKEN`; dashboard `HERMES_INTERNAL_TOKEN` + `HERMES_STORE_DIR` + the two read-only Hermes-store mounts), the Caddy 403 exclusion, and the `MailBOX.json` node-swap are applied in this branch. The on-box Publish/restart (n8n) + `docker compose up -d` (to land the mounts + Caddy change) are **operator steps** — see "Apply + activate" below.
> **What changes for the operator:** there is **no longer an n8n editor credential step.** Connecting the account once in the dashboard (**Settings → Google**) is the entire Gmail-authentication story for ingestion.

### Why the old step is retired

The runbook's §1 ("Per-account Gmail OAuth credential") and §2 (credential-per-node fan-out) had each mailbox carry its **own** `gmailOAuth2` credential created by hand in the n8n editor. That is a **third, independent** Google token store — separate from the dashboard's connection — so an operator who connected Google in the dashboard still got an empty inbox until they also hand-built the n8n credential (the exact agentbox2 "emails aren't loading" / MBOX-464 failure).

MBOX-466 makes the **dashboard's single Google connection** (backed by the **Hermes** token store, `~/.hermes/google_accounts/<email>.json`) the source of truth for all Gmail access. n8n holds **no** Gmail credential; it authenticates per-cycle by fetching a short-lived access token from a **mailbox-dashboard** internal route — which mints it from the read-only-mounted Hermes store — and calling Gmail REST directly. Hermes (host, `:9119`) is **not** in the loop.

### New credential flow (replaces §1)

1. **Operator connects the account in the dashboard** — **Settings → Google** → connect (one consent screen). This writes `~/.hermes/google_accounts/<email>.json` (refresh token + client id/secret). No n8n editor work. The Hermes consent set already grants `gmail.readonly` + `gmail.modify` (mark-read), so ingestion needs **no** additional scope or re-consent.
2. **Ensure a `mailbox.accounts` row exists for that `email_address`** (HARD prerequisite — see warning below). The dashboard Google-connect writes the Hermes token file but does **not** yet auto-create the `mailbox.accounts` row; until that wiring lands (`queries-accounts.createAccount`, `provider='gmail'`), create/adopt it on-box:

   ```bash
   # check what's there (the migration-033 default may still hold the sentinel)
   ssh <box> "docker exec mailbox-postgres psql -U mailbox -c \
     \"SELECT id,email_address,is_default FROM mailbox.accounts ORDER BY id;\""
   # adopt the sentinel default in place for the first connected account...
   ssh <box> "docker exec mailbox-postgres psql -U mailbox -c \
     \"UPDATE mailbox.accounts SET email_address='consultingfutures@gmail.com', display_label='Primary' WHERE is_default;\""
   # ...or add an additional account row for the 2nd/3rd mailbox:
   ssh <box> "docker exec mailbox-postgres psql -U mailbox -c \
     \"INSERT INTO mailbox.accounts (email_address, display_label, provider) \
       VALUES ('second@example.com','Second','gmail');\""
   ```

> **WARNING — `resolveIngestAccountId` REJECTS an unknown `account_email`; it does NOT default.** If you re-point n8n to send `account_email` (Phase 3) before that mailbox has a matching `mailbox.accounts.email_address` row, every insert 4xx's and the inbox stays dark. Create the accounts row **first**. (This is the multi-account isolation guarantee — it is the same reason the IMAP path adopts the sentinel default on connect.)

### Token authority route (the new coupling point)

Ingestion authenticates against a new **internal-only** route on the **mailbox-dashboard container** (Phase 1, `mailbox/dashboard/app/api/internal/google/access-token/route.ts`, served under the `/dashboard` basePath):

```
GET /dashboard/api/internal/google/access-token?account_email=<email>
  → 200 { "access_token": "<ya29…>", "expires_at": "<ISO8601>" }   # never returns the refresh token
  → 401 if the X-Hermes-Internal-Token header is missing/wrong (or HERMES_INTERNAL_TOKEN env unset → fail closed)
  → 400 if account_email is missing/malformed
  → 404 if that account has no token file at /hermes-store/accounts/<email>.json (not connected)
  → 502 if the Google refresh-token grant itself fails
```

It reads the per-account token file (`refresh_token`) from the **read-only-mounted** Hermes store, reads the Google client secret from `/hermes-store/client_secret.json`, runs the refresh-token grant (POST `https://oauth2.googleapis.com/token`, mirroring `dashboard/lib/oauth/google.ts:getAccessToken`), and returns the short-lived access token. The on-disk per-account file is exactly what `hermes_cli/google_accounts.py` writes (`refresh_token`, `token`, `token_uri`, `scopes`, `expiry`, `client_id`/`client_secret`, …); the route sources the refresh token from it and the client id/secret from `client_secret.json`. **Per-account isolation:** the route reads ONLY the single file named by the requested (lowercased, validated) email — **no** directory iteration — so account A's request can never return account B's token.

**The mounted store (container-side, read-only).** `mailbox/docker-compose.yml`'s mailbox-dashboard service mounts the host Hermes store read-only and sets `HERMES_STORE_DIR=/hermes-store`:

```yaml
  mailbox-dashboard:
    environment:
      HERMES_STORE_DIR: /hermes-store
      HERMES_INTERNAL_TOKEN: ${HERMES_INTERNAL_TOKEN}
    volumes:
      - ${HERMES_HOME:-${HOME}/.hermes}/google_accounts:/hermes-store/accounts:ro
      - ${HERMES_HOME:-${HOME}/.hermes}/google_client_secret.json:/hermes-store/client_secret.json:ro
```

The dashboard only ever **reads** these files (`:ro`); Hermes (host) remains the sole writer via `hermes_cli/google_accounts.py`. Hermes `:9119` is **never** called.

**Auth model (single shared-secret gate — do not weaken).** The route requires header `X-Hermes-Internal-Token` to equal env `HERMES_INTERNAL_TOKEN` (constant-time compare; **fail closed** — 401 if the env is unset). n8n sends `X-Hermes-Internal-Token: {{ $env.HERMES_INTERNAL_TOKEN }}`. Because the route lives on the docker network and is only reached by n8n at `mailbox-dashboard:3001`, the shared secret is the server-to-server auth.

**Stays off the funnel.** The route is served under `/dashboard`, so the Caddy `handle /dashboard/*` proxy would otherwise expose it. `mailbox/caddy/Caddyfile` adds a `respond 403` matcher for `path /dashboard/api/internal/google/access-token` on **both** the public (`{$DOMAIN}`) and LAN (`{$MAILBOX_LAN_HOSTNAME}`) site blocks, before the proxy. Container-network access from n8n is unaffected (it never traverses Caddy), so the spec's acceptance criterion ("token-minting endpoint unreachable from the funnel") holds.

### D3 — n8n → token route reachability (RESOLVED: container network → mailbox-dashboard)

n8n and mailbox-dashboard are both on the docker-compose network, so n8n calls the route **directly** by service name — no host-gateway, no Hermes call:

| Option | Mechanism | Verdict |
|---|---|---|
| (a) Container network → dashboard | `http://mailbox-dashboard:3001/dashboard/api/internal/google/access-token?account_email=<email>` | **CHOSEN** — same docker network the existing Insert Inbox / Cooldown / Bootstrap nodes already use; the dashboard mints from the read-only-mounted Hermes store; Hermes is untouched |
| (b) Direct to Hermes via host-gateway | `http://host.docker.internal:9119/...` + `extra_hosts: ['host.docker.internal:host-gateway']` | **Rejected/Reverted** — required a token endpoint **on** the Hermes fork (`hermes_cli/*.py` edits), which is now back to stock. Reading the mounted store from the dashboard keeps Hermes untouched |

**Decision:** n8n's "Get Gmail Token" node calls `http://mailbox-dashboard:3001/dashboard/api/internal/google/access-token?account_email={{ … }}` with header `X-Hermes-Internal-Token: {{ $env.HERMES_INTERNAL_TOKEN }}`. The **n8n** service gets `HERMES_INTERNAL_TOKEN` in its env (the caller); the **mailbox-dashboard** service gets the same `HERMES_INTERNAL_TOKEN` (the verifier) plus the store mounts + `HERMES_STORE_DIR` above. Set `HERMES_INTERNAL_TOKEN` once in the compose `.env`; it is referenced by both services. The n8n `extra_hosts: host.docker.internal` from the earlier draft is **removed** — no longer needed.

### Fan-out topology (replaces §2)

The serial, one-branch-per-account topology from §2 is **unchanged in shape** — only the per-branch Gmail step changes. Each branch's `Get many messages` **gmail** node is replaced by an httpRequest chain:

```
Bootstrap Check  (also surfaces account_email alongside gmail_get_limit)
  └─ Get Gmail Token   httpRequest GET http://mailbox-dashboard:3001/dashboard/api/internal/google/access-token?account_email={{A}}
                          header  X-Hermes-Internal-Token: {{ $env.HERMES_INTERNAL_TOKEN }}
       └─ Gmail List   httpRequest GET https://gmail.googleapis.com/gmail/v1/users/me/messages
                          q="is:unread in:inbox -from:me newer_than:2d"  maxResults={{gmail_get_limit}}
                          Authorization: Bearer {{ $('Get Gmail Token').item.json.access_token }}
            └─ split messages[] → one item per message id
                 └─ Gmail Get   httpRequest GET …/messages/{{ $json.id }}?format=full   (Bearer)
                      └─ Normalize Gmail   (Code node → rebuild simpleParser shape: from.value[0].address,
                                            to.value[0].address, subject, date, text, inReplyTo, references)
                           └─ Insert Inbox (HTTP)   body MUST add  account_email: <A>
```

- **Preserve the EXACT query** `is:unread in:inbox -from:me newer_than:2d` and the existing `limit` binding (`{{ $('Bootstrap Check').item.json.gmail_get_limit }}`).
- The replacement chain's **final** node must keep the name `Get many messages` (or rewire) so the existing `main[0]` connections to **both** `Extract Fields` **and** `Cycle Stats` (which counts `items.length` as `messages_returned`) stay intact.
- **Critical normalization trap:** the old n8n gmail node emitted simpleParser-resolved fields even with `simple:false`. Raw Gmail REST does **not**. The `Normalize Gmail` Code node must rebuild the exact parsed shape (case-insensitive header lookup; base64url-decode the `text/plain` part; strip `Name <email>` to the bare address) or `from_addr`/`to_addr`/`subject`/`body` silently come through empty and downstream RAG sender filters break.
- **Insert Inbox MUST send `account_email`.** Today the Gmail branch's `Insert Inbox (HTTP)` body omits it (legacy single-account path → default account). Phase 3 adds `account_email` per branch so `resolveIngestAccountId` stamps the correct `account_id`. (The IMAP path already sends it; the route already accepts it — only the Gmail branch never populated it.)
- **Delete the `credentials.gmailOAuth2` block** with the old node — this satisfies the acceptance criterion that n8n holds no `gmailOAuth2` credential.

### Apply + activate (unchanged operational rules)

1. **Set the shared secret** — `HERMES_INTERNAL_TOKEN=<openssl rand -hex 32>` in the compose `.env` (referenced by both the n8n and mailbox-dashboard services). Confirm `HERMES_HOME` resolves to the host Hermes store (default `${HOME}/.hermes`) so the read-only mounts land on the real `google_accounts/` + `google_client_secret.json`.
2. **Apply the compose + Caddy changes** — the new dashboard env + read-only store mounts and the n8n env land on `docker compose up -d` (not `restart` — env/volume changes need recreate); the Caddy 403 exclusion lands on `docker compose up -d caddy` (bind-mounted Caddyfile; `restart` keeps stale config per root CLAUDE.md).
3. **Publish the workflow** — editing `MailBOX.json` in the repo changes **nothing** at runtime (n8n 2.x reads `workflow_published_version`, not `workflow_entity`). After the node swap: **edit-then-Publish** in the n8n editor, then `docker compose restart n8n`, then re-run the activation gate so all four `MailBOX*` workflows are `active=true`:

```bash
ssh <box> "cd ~/mailbox && docker compose --profile n8n-verify run --rm mailbox-n8n-verify"   # exit 0 = all 4 active
```

### Acceptance (adds to §Verification)

- [ ] Operator connects a Google account in **Settings → Google** and performs **no** n8n editor work.
- [ ] Within ≤5 min, that account's mail lands in `mailbox.inbox_messages` (tagged `account_email`) and drafts surface in Incoming Messages.
- [ ] n8n `credentials_entity` contains **no** `gmailOAuth2` credential.
- [ ] Per-account isolation verified (account A's cycle cannot fetch account B's mail).
- [ ] `GET /dashboard/api/internal/google/access-token` is unreachable from the funnel — Caddy returns **403** for that path on both the public and LAN site blocks; only the docker network (n8n → `mailbox-dashboard:3001`) reaches it, authorized by the `X-Hermes-Internal-Token` shared secret. Hermes `:9119` is never exposed and never called.
