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
