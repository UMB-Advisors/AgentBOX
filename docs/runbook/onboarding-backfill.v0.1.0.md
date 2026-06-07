# Onboarding Backfill Runbook v0.1.0

**Status:** v0.1.0 — first version, tracks STAQPRO-193. Validated end-to-end on customer #1 (`dustin@heronlabsinc.com`) before merge.

**Audience:** Operator running the canonical "new customer joins" onboarding step against a freshly-provisioned MailBox appliance.

**Tracks:** STAQPRO-193. Parent track: STAQPRO-122 (M3.5 — RAG over Qdrant).

---

## What this runbook covers

The Gmail Sent backfill seeds the appliance's RAG corpus with the operator's reply history before retrieval (STAQPRO-191) ever runs. Without it, retrieval has zero or near-zero corpus on day 1 and pulls noise. The backfill is **the** customer-#2 onboarding step — every new appliance follows the same path:

1. Customer authorizes Gmail OAuth via n8n (existing creds reused — no new credential surface).
2. Operator runs the backfill command (canonical path: dashboard CLI).
3. Operator validates corpus shape with the post-run query in §4.
4. Operator (optionally) fires `npm run rag:backfill` to embed the seeded rows into Qdrant.

---

## Prereqs

| Item | Why | Where |
|---|---|---|
| Appliance reachable over SSH (`jetson` or `mailbox1`) | Container exec | Direct ethernet 10.42.0.2, or tailnet `mailbox1.tail377a9a.ts.net` |
| `mailbox-dashboard` container running | The CLI runs inside the dashboard container | `docker compose ps mailbox-dashboard` |
| `MailBOX-FetchHistory` n8n workflow imported + active | The backfill calls this webhook over docker DNS | `n8n/workflows/MailBOX-FetchHistory.json` |
| Gmail OAuth credential `vEz5mz0uaAtlK8yz` valid | The webhook authenticates via this credential | n8n editor → Credentials → "Gmail account" |
| `MAILBOX_OPERATOR_EMAIL` set in `.env` | Identifies which messages in each thread are "my reply" | `/home/bob/mailbox/.env` |

If any of these are missing, stop and fix first. The backfill cannot recover from a misconfigured webhook or Gmail credential.

---

## Importing the n8n sub-workflow

Until the n8n CLI activation race is resolved (see project conventions), import the workflow JSON manually:

1. Open the n8n editor at `http://192.168.1.45:5678` (LAN-only).
2. Click "Workflows" → "Import from File".
3. Select `/home/bob/mailbox/n8n/workflows/MailBOX-FetchHistory.json`.
4. Activate the workflow (toggle in the top-right).
5. Verify the webhook is registered: `curl http://localhost:5678/webhook/mailbox-fetch-history -X POST -H 'content-type: application/json' -d '{"days_lookback":7,"max_messages":1}'` should return `{ok:true, ...}`.

The workflow takes `{ days_lookback: number, max_messages?: number }` in its body and returns `{ ok, days_lookback, after_date, thread_count, threads }` where each thread is the full Gmail thread shape (`{ id, messages: [{ id, threadId, internalDate, payload: { headers, parts, ... } }] }`).

---

## Running the backfill

### Canonical path (CLI via the migrate one-shot container)

From the workstation:

```bash
ssh mailbox1 'cd ~/mailbox && docker compose --profile migrate run --rm \
  -e MAILBOX_OPERATOR_EMAIL=dustin@heronlabsinc.com \
  -e OLLAMA_BASE_URL=http://ollama:11434 \
  -e QDRANT_URL=http://qdrant:6333 \
  -e MAILBOX_FETCH_HISTORY_URL=http://n8n:5678/webhook/mailbox-fetch-history \
  -e RAG_BACKFILL_LOOKBACK_DAYS=200 \
  mailbox-migrate sh -c "npm install --no-audit --no-fund --silent && \
    npm run onboarding:backfill -- --days 180 --embed"'
```

> **Why not `docker compose run mailbox-dashboard`?** The prod `mailbox-dashboard` image is the built Next.js artifact and ships **no devDependencies** — `tsx` (the script runner) isn't there, so the npm script fails with `sh: tsx: not found`. The `mailbox-migrate` profile is a `node:20-alpine` one-shot that bind-mounts `./dashboard` and runs `npm install` first; that gives us tsx + the rest of the dev tooling. Same shape used by `npm run migrate`.

> **Why pass env vars with `-e`?** The `mailbox-migrate` service's `environment:` block in `docker-compose.yml` only declares `POSTGRES_URL`. Other vars from `.env` do not pass through to a one-shot run — they have to be set explicitly on the command line.

> **Why `RAG_BACKFILL_LOOKBACK_DAYS=200` when we passed `--days 180`?** The `--days` flag scopes the **gmail-history** fetch only. The chained `rag-backfill` step (triggered by `--embed`) reads its own `RAG_BACKFILL_LOOKBACK_DAYS` env (default 90). Set it ≥ `--days` so every row that landed in Postgres gets embedded. Otherwise you'll see Qdrant `points_count` ≈ half of `sent_history` total. Set to 200 (not 180) to clear the day-boundary fuzz from Gmail's `after:YYYY/MM/DD` floor.

This:

1. Calls `MailBOX-FetchHistory` over docker DNS (`http://n8n:5678/webhook/mailbox-fetch-history`).
2. For each returned thread, walks messages chronologically and emits one `(inbound, reply)` pair per outbound message authored by `MAILBOX_OPERATOR_EMAIL`.
3. UPSERTs inbound rows into `mailbox.inbox_messages` (idempotent on `message_id`).
4. UPSERTs reply rows into `mailbox.sent_history` (idempotent on `message_id`, `source = 'backfill'` per migration 011).
5. With `--embed`: chains `rag-backfill` to embed all rows (within `RAG_BACKFILL_LOOKBACK_DAYS`) via nomic-embed-text and upsert to Qdrant.
6. Logs aggregate counts. Bodies are never logged.

To run embedding separately later (without re-fetching from Gmail):

```bash
ssh mailbox1 'cd ~/mailbox && docker compose --profile migrate run --rm \
  -e OLLAMA_BASE_URL=http://ollama:11434 \
  -e QDRANT_URL=http://qdrant:6333 \
  -e RAG_BACKFILL_LOOKBACK_DAYS=200 \
  mailbox-migrate sh -c "npm install --no-audit --no-fund --silent && \
    npx tsx scripts/rag-backfill.ts"'
```

### Wizard hook (HTTP)

The same orchestrator is exposed at `POST /api/onboarding/backfill`. The M4 onboarding wizard will call this — until then the CLI is the operator surface. The route inherits Caddy basic_auth via the existing `/dashboard/*` matcher.

```bash
curl -u operator:<password> -X POST https://mailbox.heronlabsinc.com/api/onboarding/backfill \
  -H 'content-type: application/json' \
  -d '{"days_lookback": 180}'
```

Response: `{ ok: true, counts: { threads_seen, pairs_extracted, inbox_upserts, ... }, elapsed_ms }`.

---

## Post-run validation

Confirm the corpus seeded. From the workstation:

```bash
ssh mailbox1 'docker compose -f ~/mailbox/docker-compose.yml exec -T postgres \
  psql -U mailbox -d mailbox -c "
    SELECT
      (SELECT COUNT(*) FROM mailbox.inbox_messages)         AS inbox_total,
      (SELECT COUNT(*) FROM mailbox.sent_history WHERE source = '\''backfill'\'') AS sent_backfill,
      (SELECT COUNT(*) FROM mailbox.sent_history WHERE source = '\''live'\'')     AS sent_live;
  "'
```

Expected after a 180-day backfill on `dustin@heronlabsinc.com`:
- `inbox_total` increases by hundreds-to-thousands.
- `sent_backfill` is non-zero and roughly tracks the number of (inbound, reply) pairs the orchestrator extracted.
- `sent_live` is unchanged from before the run (live archival path is untouched).

Re-running the same `--days 180` window is a no-op against the already-seeded rows (UPSERT on `message_id`).

If you also ran with `--embed`, validate the Qdrant collection point count:

```bash
ssh mailbox1 'curl -s http://localhost:6333/collections/email_messages | jq .result.points_count'
```

A value of ≥1 confirms the embedding chain wrote real points. Compare to `inbox_total + sent_backfill + sent_live` from above — embedding may legitimately skip rows with empty bodies.

---

## Idempotency + safety

- **Re-run safe.** UPSERT on `message_id` means re-running the same lookback window is a near-no-op (just re-fetches threads from Gmail). Per Locked Decision #5 there is no cursor table; that's the whole point.
- **Hard cap.** `RAG_BACKFILL_MAX_MESSAGES` env (default 5000) bounds the run. The cap is enforced inside the n8n sub-workflow so a runaway pull never reaches Postgres.
- **PII scrub.** Bodies are scrubbed (US phone, SSN, credit-card-ish 16-digit) inside `buildBodyExcerpt` before they reach Qdrant — original bodies remain untouched in `mailbox.inbox_messages.body` / `mailbox.sent_history.draft_sent` so the operator can see the unscrubbed text in the dashboard.
- **No body in logs.** The orchestrator logs only `message_id`s and aggregate counts. Any error includes the offending `message_id` for debugging but never the body.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `MAILBOX_OPERATOR_EMAIL not set` (CLI) or `error: misconfigured` (HTTP) | Env var missing in the dashboard service | Add `MAILBOX_OPERATOR_EMAIL=dustin@heronlabsinc.com` (or the customer's address) to `/home/bob/mailbox/.env` and `docker compose up -d mailbox-dashboard` |
| `fetch-history responded 404 (non-retry)` | n8n workflow not imported / not active | Re-import `MailBOX-FetchHistory.json` and activate it |
| `fetch-history responded 401` | Gmail OAuth credential expired or scope insufficient | Re-authorize the "Gmail account" credential in the n8n editor; needs `gmail.readonly` or wider (existing inbound creds with `gmail.modify` are sufficient) |
| Counts say `pairs_extracted = 0` despite many threads | `MAILBOX_OPERATOR_EMAIL` doesn't match the From header on any sent message | Verify the value matches what shows in your Gmail "Sent" folder; matching is case-insensitive |
| Qdrant point count stays 0 after `--embed` | Ollama unreachable or `nomic-embed-text:v1.5` not pulled | `docker compose exec ollama ollama list` then `ollama pull nomic-embed-text:v1.5` if missing |

---

## Customer-#1 baseline

First run on `dustin@heronlabsinc.com`, 2026-05-02, `--days 180 --embed`:

| Metric | Value |
|---|---|
| Threads seen | 217 |
| Pairs extracted | 441 |
| `inbox_messages` total post-run | 431 |
| `sent_history` (`source='backfill'`) | 441 |
| `sent_history` (`source='live'`) | 1 (untouched) |
| Qdrant `email_messages.points_count` | **865** |
| Wall-clock — gmail-history fetch + write | ~253s (~4m 13s) |
| Wall-clock — chained embed (90d default) | ~310s (259 rows) |
| Wall-clock — catch-up embed (`RAG_BACKFILL_LOOKBACK_DAYS=200`) | ~720s (606 additional rows) |
| Wall-clock — total | ~22 minutes |
| Date range | 2025-08-23 → 2026-05-01 |

### Notes from the first run (caused real fixes)

- **Parser bug — PR #29 (STAQPRO-193 follow-up).** First run reported `pairs_extracted: 0` from 217 valid threads. Root cause: `MailBOX-FetchHistory` flattens Gmail headers (`From`, `To`, `Subject`, `Message-Id`, etc.) onto each message's top-level instead of preserving `payload.headers[]`. The parser was hardcoded to the standard shape. PR #29 added a `messageHeader()` fallback that reads either shape; re-run produced the 441 pairs above.
- **Runbook command was wrong.** The originally-shipped runbook said `docker compose run --rm mailbox-dashboard npm run onboarding:backfill ...`. The prod `mailbox-dashboard` image ships no devDeps so `tsx` is missing — the script fails with `sh: tsx: not found`. Updated above to use the `mailbox-migrate` one-shot pattern (same as `npm run migrate`).
- **Chained embed defaults to 90d.** `--embed` chains `rag-backfill.ts` which reads `RAG_BACKFILL_LOOKBACK_DAYS` (default 90). Pass it explicitly ≥ `--days` or only half the corpus gets embedded. Initial run produced 259 Qdrant points (90d window only); catch-up run with `RAG_BACKFILL_LOOKBACK_DAYS=200` brought it to 865.
- **Env vars don't pass through.** `mailbox-migrate`'s compose service only declares `POSTGRES_URL`. Other env vars from `.env` are not visible in a one-shot run; pass them explicitly via `-e`.
- **No rate-limit retries triggered.** Gmail API behaved across the full 217-thread fetch; no 429s in the run.
- **8 rows skipped at embed time.** 873 source rows in Postgres → 865 Qdrant points. Those 8 are rows where `buildEmbeddingInput(subject, excerpt)` produced an empty string after PII scrub + body extraction (probably attachment-only messages).

### What this baseline locks in

- The corpus (865 points, 768-dim cosine, nomic-embed-text:v1.5) is large enough to demonstrate retrieval signal. STAQPRO-191 (re-implementation) and STAQPRO-192 (eval harness) can now run against real data.
- Customer #2 should match this within order-of-magnitude. If their numbers diverge by ≥10× (much smaller mailbox, much larger), the cap-tuning question reopens (revisit the cursor-table decision).
