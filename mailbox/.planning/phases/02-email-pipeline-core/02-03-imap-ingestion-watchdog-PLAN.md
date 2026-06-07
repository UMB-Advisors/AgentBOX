---
status: SUPERSEDED
superseded_by: 02-03-imap-ingestion-watchdog-PLAN-v2-2026-04-27-STUB.md (architectural rescope) and 02-03-imap-ingestion-watchdog-SUMMARY.md (what shipped 2026-04-28)
supersession_date: 2026-04-27
supersession_reason: 2026-04-27 Next.js full-stack ADR retired the Express backend layout this plan implicitly assumed. Additionally, the IMAP-trigger + watchdog architecture was rendered moot per D-30 — the live workflow uses Gmail node + Schedule Trigger (no trigger-death bug). See ADR in `.planning/STATE.md` and SUMMARY for what actually shipped.
plan_number: 02-03
slug: imap-ingestion-watchdog
wave: 3
depends_on: [02-02]
autonomous: false
requirements: [MAIL-01, MAIL-02, MAIL-03, MAIL-04, MAIL-05, MAIL-14]
files_modified:
  - n8n/workflows/01-email-pipeline-main.json
  - n8n/workflows/02-imap-watchdog.json
  - n8n/README.md
  - scripts/n8n-import-workflows.sh
  - docker-compose.yml
---

<objective>
Ingest inbound email from the customer's Gmail inbox via the n8n IMAP trigger, persist each message once into `mailbox.email_raw` (with thread headers preserved per D-24), and hand the row off to the classification sub-workflow for routing. A watchdog sub-workflow runs every 5 minutes, restarts the main workflow if its last execution is stale (the n8n IMAP trigger death bug per STATE.md), and emails the operator after two consecutive restart failures. n8n workflows are stored as JSON files under `n8n/workflows/` so they are committable and OTA-updatable.
</objective>

<must_haves>
- A real Gmail email delivered to the dogfood Heron Labs inbox appears as a row in `mailbox.email_raw` within 90 seconds of delivery (SLA budget: 60s IMAP poll + 30s pipeline)
- The `email_raw` row carries `message_id`, `thread_id`, `in_reply_to`, `references`, `from_addr`, `to_addr`, `subject`, `body_text` (extracted from HTML if needed)
- The main workflow triggers a classification sub-workflow (implemented in Plan 02-04) via Execute Workflow node, passing the new `email_raw.id`
- The watchdog sub-workflow is active and runs on a 5-minute cron
- If the main workflow has not executed in >10 minutes (2× the poll interval), the watchdog restarts it; after 2 consecutive restart failures, the watchdog sends an operator email
- Both workflows are committed as JSON files and imported via `scripts/n8n-import-workflows.sh`
</must_haves>

<threat_model>
**ASVS L1, block on HIGH.**

| Surface | Threat | Mitigation | Severity |
|---------|--------|------------|----------|
| Gmail OAuth2 refresh token | Leak via n8n credential export | n8n credentials are encrypted at rest using `N8N_ENCRYPTION_KEY` (Phase 1 env); the workflow JSON files committed here reference credentials by name, NEVER embed token values | High → mitigated |
| Inbound email body | Prompt injection carried downstream to Qwen3 classifier and Claude drafter | Store email body as untrusted `text` in `email_raw`; all downstream prompt templates (Plans 04, 07) treat the body as data inside a fenced `<email>` block, never as instructions. Human-in-the-loop approval gate is the ultimate backstop | High → mitigated in-plan + defense-in-depth downstream |
| Watchdog operator email SMTP creds | Same credential surface as customer SMTP — reuse the customer's own SMTP credential | SMTP credential stored only in n8n encrypted store; watchdog email uses the customer's configured SMTP account | Medium |
| IMAP trigger replay on duplicate `message_id` | Duplicate rows in `email_raw` | Unique index `email_raw_message_id_uq` from Plan 02 ensures idempotency; workflow handles unique-violation by skipping | Low → mitigated |
| PII at rest in `email_raw` | Local storage with no customer-level auth in Phase 2 | Inherits Phase 2 LAN-only trust boundary; documented in SECURITY.md. NVMe LUKS (INFRA-11) is the at-rest-encryption control, applied separately | Medium, deferred (LUKS = Phase 1) |
| n8n workflow file in git | Credential config leakage | Workflow JSON MUST contain no `credentials` inline values. `scripts/n8n-import-workflows.sh` verifies before import | High → mitigated |

No HIGH-severity unmitigated threats.
</threat_model>

<tasks>

<task id="1">
<action>
Create the host-side directory structure for n8n workflows so they are committable and OTA-updatable:

```bash
mkdir -p n8n/workflows
```

Create `n8n/README.md` documenting the workflow export/import contract:

```markdown
# n8n Workflows — MailBox One

Committable workflow definitions for the n8n 2.14.2 container. Import on first boot via `scripts/n8n-import-workflows.sh`; re-import replaces workflows by name.

## Contract
- Each JSON file is a single workflow export from `n8n export:workflow --pretty`.
- Credentials are referenced by **name**, not by **id** — names are created once in the n8n UI (Gmail OAuth2, customer SMTP, Postgres mailbox, Ollama).
- Never commit files containing `"credentials": { ... inline values ... }`.
- Workflow `active: true` flag is preserved by the import script.

## Workflows
| File | Purpose | Trigger |
|------|---------|---------|
| 01-email-pipeline-main.json | Ingest inbound email → email_raw → classify | IMAP trigger |
| 02-imap-watchdog.json | Restart dead IMAP trigger, alert on failure | Cron (every 5 minutes) |
```

Mount `n8n/workflows/` read-only into the n8n container so the import script can read the files from inside. Update the `n8n` service in `docker-compose.yml`:

```yaml
    volumes:
      - n8n_data:/home/node/.n8n
      - ./n8n/workflows:/workflows:ro
```
</action>
<read_first>
  - docker-compose.yml  (current n8n volumes)
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-22 watchdog)
</read_first>
<acceptance_criteria>
- `n8n/workflows/` directory exists
- `n8n/README.md` exists and contains "01-email-pipeline-main.json" and "02-imap-watchdog.json"
- `grep -A 5 'n8n:' docker-compose.yml | grep './n8n/workflows:/workflows:ro'` matches
</acceptance_criteria>
</task>

<task id="2">
<action>
Create `n8n/workflows/01-email-pipeline-main.json` — the main ingestion workflow. Node graph:

1. **IMAP Trigger** (built-in) — credential by name `Gmail IMAP`, mailbox `INBOX`, poll interval `60` seconds, download attachments `false`, include unread only `true`. Output is one item per new message with `{ from, to, subject, text, html, messageId, headers }`.
2. **Function: Extract Headers** — parses In-Reply-To and References from `$json.headers`. Output enriched item:
   ```js
   const h = $json.headers || {};
   const refs = h['references'] || h['References'] || '';
   return [{ json: {
     ...$json,
     in_reply_to: h['in-reply-to'] || h['In-Reply-To'] || null,
     references: Array.isArray(refs) ? refs.join(' ') : refs,
     thread_id: (h['message-id'] || h['Message-ID'] || '').toString().replace(/[<>]/g,''),
   }}];
   ```
3. **Function: Normalize Body** — if `$json.text` is empty, strip HTML from `$json.html` using a deterministic function (no external deps). Set `body_text` = stripped text, `body_html` = original html.
4. **Postgres: Insert email_raw** — credential `Postgres Mailbox`, operation `insert`, schema `mailbox`, table `email_raw`, columns mapped:
   - `message_id` ← `{{$json.messageId}}`
   - `thread_id` ← `{{$json.thread_id}}`
   - `in_reply_to` ← `{{$json.in_reply_to}}`
   - `references` ← `{{$json.references}}`
   - `from_addr` ← `{{$json.from}}`
   - `to_addr` ← `{{$json.to}}`
   - `subject` ← `{{$json.subject}}`
   - `body_text` ← `{{$json.body_text}}`
   - `body_html` ← `{{$json.body_html}}`
   - `received_at` ← `{{$json.date}}`
   - **Conflict handling:** `ON CONFLICT (message_id) DO NOTHING RETURNING id` — implemented via the Postgres node's "Upsert" mode keyed on `message_id`. Output `id` for next step.
5. **IF: Row Inserted** — `{{$json.id}}` is truthy (skip duplicates silently).
6. **Execute Workflow: classify-email-sub** — passes `{ email_raw_id: $json.id }`. The sub-workflow is implemented in Plan 02-04.

Workflow JSON must be a valid n8n 2.14.2 export. Top-level fields:
```json
{
  "name": "01-email-pipeline-main",
  "active": true,
  "nodes": [ ... ],
  "connections": { ... },
  "settings": { "executionOrder": "v1", "saveExecutionProgress": true },
  "staticData": null,
  "tags": [{"name":"phase-2"}, {"name":"ingestion"}],
  "triggerCount": 1
}
```

Do NOT embed credential values. Use the built-in credential reference format:
```json
"credentials": {
  "imap": { "name": "Gmail IMAP" },
  "postgres": { "name": "Postgres Mailbox" }
}
```
</action>
<read_first>
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-22 IMAP, D-24 thread headers)
  - .planning/REQUIREMENTS.md  (MAIL-02 60s poll, MAIL-04 HTML+plain+threading)
  - dashboard/backend/src/db/schema.ts  (email_raw column names)
</read_first>
<acceptance_criteria>
- `n8n/workflows/01-email-pipeline-main.json` exists and is valid JSON: `python3 -c 'import json,sys; json.load(open("n8n/workflows/01-email-pipeline-main.json"))'` exits 0
- `jq -r '.name' n8n/workflows/01-email-pipeline-main.json` returns `01-email-pipeline-main`
- `jq -r '.active' n8n/workflows/01-email-pipeline-main.json` returns `true`
- `jq '[.nodes[] | select(.type == "n8n-nodes-base.emailReadImap")] | length' n8n/workflows/01-email-pipeline-main.json` returns `1`
- `jq '[.nodes[] | select(.type == "n8n-nodes-base.postgres")] | length' n8n/workflows/01-email-pipeline-main.json` returns at least `1`
- `jq '[.nodes[] | select(.type == "n8n-nodes-base.executeWorkflow")] | length' n8n/workflows/01-email-pipeline-main.json` returns at least `1`
- `grep -c '"name": "Gmail IMAP"' n8n/workflows/01-email-pipeline-main.json` returns at least `1`
- `grep -c '"name": "Postgres Mailbox"' n8n/workflows/01-email-pipeline-main.json` returns at least `1`
- **Negative check:** `grep -c '"password"' n8n/workflows/01-email-pipeline-main.json` returns `0` (no inline credentials)
- **Negative check:** `grep -c 'accessToken' n8n/workflows/01-email-pipeline-main.json` returns `0`
</acceptance_criteria>
</task>

<task id="3">
<action>
Create `n8n/workflows/02-imap-watchdog.json` — watchdog sub-workflow. Node graph:

1. **Cron trigger** — every 5 minutes.
2. **Postgres Query: check last execution** — reads from n8n's own `public.execution_entity` table:
   ```sql
   SELECT MAX(finished) AS last_finished, MAX(started_at) AS last_started
   FROM public.execution_entity
   WHERE workflow_id = (SELECT id FROM public.workflow_entity WHERE name = '01-email-pipeline-main')
     AND finished IS NOT NULL;
   ```
3. **Function: Detect Stale** — compares `last_finished` to `now()`. Stale = `now - last_finished > 10 minutes`. Emits `{ stale: true, last_finished }` or `{ stale: false }`.
4. **IF stale** — branches to restart path.
5. **HTTP Request: Deactivate** — `POST http://n8n:5678/rest/workflows/{id}/deactivate` via n8n's own internal REST API. Use an internal n8n API token stored as credential `N8N Internal API`.
6. **HTTP Request: Activate** — `POST http://n8n:5678/rest/workflows/{id}/activate` immediately after.
7. **Function: Track Failure Count** — reads/writes `staticData.global.watchdogFailures`. If activate failed (HTTP non-2xx), increment; else reset to 0.
8. **IF `watchdogFailures >= 2`** — branches to alert path.
9. **Email Send** — uses credential `Customer SMTP`, to = `{{ $env.OPERATOR_EMAIL }}` or a workflow parameter, subject `[MailBox One] IMAP trigger stalled`, body mentions last execution timestamp and failure count. Resets the counter after successful send.

Workflow JSON shape:
```json
{
  "name": "02-imap-watchdog",
  "active": true,
  "nodes": [ ... ],
  "connections": { ... },
  "settings": { "executionOrder": "v1" },
  "staticData": { "global": { "watchdogFailures": 0 } },
  "tags": [{"name":"phase-2"}, {"name":"watchdog"}]
}
```
</action>
<read_first>
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-22)
  - .planning/REQUIREMENTS.md  (MAIL-03)
  - n8n/workflows/01-email-pipeline-main.json  (workflow name reference)
</read_first>
<acceptance_criteria>
- `n8n/workflows/02-imap-watchdog.json` exists and is valid JSON
- `jq -r '.name' n8n/workflows/02-imap-watchdog.json` returns `02-imap-watchdog`
- `jq '[.nodes[] | select(.type == "n8n-nodes-base.cron")] | length' n8n/workflows/02-imap-watchdog.json` returns `1`
- `jq '[.nodes[] | select(.type == "n8n-nodes-base.emailSend")] | length' n8n/workflows/02-imap-watchdog.json` returns `1`
- `grep -c 'watchdogFailures' n8n/workflows/02-imap-watchdog.json` returns at least `1`
- `grep -c '01-email-pipeline-main' n8n/workflows/02-imap-watchdog.json` returns at least `1`
- **Negative check:** `grep -c '"password"' n8n/workflows/02-imap-watchdog.json` returns `0`
</acceptance_criteria>
</task>

<task id="4">
<action>
Create `scripts/n8n-import-workflows.sh` — idempotent import script that copies workflow JSON into the running n8n container, runs the n8n CLI import, and verifies none of the files contain inline credential secrets before importing:

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

WORKFLOW_DIR="n8n/workflows"

# Safety gate: reject any file with inline credential secrets
echo "→ Validating workflow JSON files for credential safety..."
if grep -r -l '"password"\|accessToken\|refreshToken\|clientSecret' "$WORKFLOW_DIR"/*.json 2>/dev/null; then
  echo "ERROR: inline credential values found in workflow files above. Refusing to import." >&2
  exit 1
fi

echo "→ Importing workflows into n8n container..."
for f in "$WORKFLOW_DIR"/*.json; do
  name=$(basename "$f")
  echo "   - $name"
  docker compose exec -T n8n n8n import:workflow --input="/workflows/$name"
done

echo "→ Verifying import..."
docker compose exec -T n8n n8n list:workflow | tee /tmp/n8n-workflows.txt
grep -q '01-email-pipeline-main' /tmp/n8n-workflows.txt
grep -q '02-imap-watchdog' /tmp/n8n-workflows.txt

echo "→ Import complete."
```

Make it executable: `chmod +x scripts/n8n-import-workflows.sh`.
</action>
<read_first>
  - n8n/workflows/01-email-pipeline-main.json
  - n8n/workflows/02-imap-watchdog.json
  - docker-compose.yml  (n8n volumes)
</read_first>
<acceptance_criteria>
- `scripts/n8n-import-workflows.sh` exists and is executable (`test -x scripts/n8n-import-workflows.sh`)
- `grep '"password"' scripts/n8n-import-workflows.sh` matches (safety gate present)
- `grep 'n8n import:workflow' scripts/n8n-import-workflows.sh` matches
- `grep 'list:workflow' scripts/n8n-import-workflows.sh` matches
</acceptance_criteria>
</task>

<task id="5">
<action>
Provision the n8n credentials in the running n8n instance via the UI, then run the import script. This is a manual step because Gmail OAuth2 requires a browser redirect.

**Operator steps (document in `n8n/README.md`):**

1. Open `http://<appliance-ip>:5678` in a browser.
2. Create credentials (Settings → Credentials → New):
   - **Gmail IMAP** (IMAP type): host `imap.gmail.com`, port `993`, SSL `true`, user = dogfood email address, "Use OAuth2" path or app password depending on Gmail mode. For Phase 2 dogfood in Testing mode (per STATE.md), use OAuth2 with Google Cloud Console's test-user list.
   - **Postgres Mailbox**: host `postgres`, port `5432`, database `${POSTGRES_DB}`, user `${POSTGRES_USER}`, password `${POSTGRES_PASSWORD}`, schema `mailbox`, SSL `disable`.
   - **Customer SMTP**: host `smtp.gmail.com`, port `587`, user = same dogfood address, secure `tls`.
   - **N8N Internal API**: generate a personal API key from n8n UI Settings → API → Create API Key; paste into credential.
3. Run the import:
   ```bash
   ./scripts/n8n-import-workflows.sh
   ```
4. Re-activate the main workflow if the import does not preserve `active: true`:
   ```bash
   docker compose exec -T n8n n8n update:workflow --active=true --id=<workflow-id>
   ```

Append to `n8n/README.md` under a `## First-time setup` heading.
</action>
<read_first>
  - n8n/README.md
  - .planning/STATE.md  (§Decisions for Gmail OAuth2 Testing mode)
  - scripts/n8n-import-workflows.sh
</read_first>
<acceptance_criteria>
- `n8n/README.md` contains a `## First-time setup` section
- `grep 'Gmail IMAP' n8n/README.md` matches
- `grep 'Postgres Mailbox' n8n/README.md` matches
- `grep 'Customer SMTP' n8n/README.md` matches
- `grep 'N8N Internal API' n8n/README.md` matches
- After running `./scripts/n8n-import-workflows.sh`, `docker compose exec -T n8n n8n list:workflow | grep -c '01-email-pipeline-main'` returns at least `1`
- `docker compose exec -T n8n n8n list:workflow | grep -c '02-imap-watchdog'` returns at least `1`
</acceptance_criteria>
</task>

<task id="6">
<action>
End-to-end smoke test: send a test email from any external account to the dogfood inbox, wait 90 seconds, then confirm a new row appears in `mailbox.email_raw`. Capture the row for use by Plan 02-04 testing.

```bash
# 1. Record baseline row count
BEFORE=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COUNT(*) FROM mailbox.email_raw;")
echo "before: $BEFORE"

# 2. Operator: send a test email to the dogfood Gmail inbox from another account with subject "MailBox Phase 2 smoke"

# 3. Wait up to 120s for the IMAP poll cycle
for i in $(seq 1 12); do
  AFTER=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COUNT(*) FROM mailbox.email_raw;")
  echo "[$i] after: $AFTER"
  if [ "$AFTER" -gt "$BEFORE" ]; then break; fi
  sleep 10
done

# 4. Inspect the latest row
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT id, from_addr, subject, thread_id, in_reply_to, references
  FROM mailbox.email_raw ORDER BY id DESC LIMIT 1;
"
```

Since Plan 02-04 has not landed yet, the Execute Workflow step in the main workflow will log an error ("sub-workflow not found"). That is acceptable for this plan — the `email_raw` row must still be written before the Execute step fires. Plans 02-04 and 02-07 will close the loop.
</action>
<read_first>
  - n8n/workflows/01-email-pipeline-main.json
  - dashboard/backend/src/db/schema.ts
</read_first>
<acceptance_criteria>
- A new row is present in `mailbox.email_raw` after the test send (row count increases by at least 1)
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT from_addr FROM mailbox.email_raw ORDER BY id DESC LIMIT 1;"` is non-empty
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT thread_id FROM mailbox.email_raw ORDER BY id DESC LIMIT 1;"` is non-empty
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COUNT(*) FROM mailbox.email_raw WHERE message_id IS NOT NULL AND from_addr IS NOT NULL AND received_at IS NOT NULL;"` is at least `1`
</acceptance_criteria>
</task>

<task id="7">
<action>
Verify the watchdog sub-workflow is active and detects staleness. Manually simulate a stale state by deactivating the main workflow and observing the watchdog behavior on the next 5-minute tick:

```bash
# 1. Confirm watchdog is active
docker compose exec -T n8n n8n list:workflow | grep -E '02-imap-watchdog.*active'

# 2. Deactivate main workflow to simulate a dead trigger
MAIN_ID=$(docker compose exec -T n8n n8n list:workflow | awk '/01-email-pipeline-main/ {print $1}')
docker compose exec -T n8n n8n update:workflow --active=false --id="$MAIN_ID"

# 3. Wait for next watchdog tick (up to 6 minutes)
sleep 360

# 4. Check that main workflow was reactivated by the watchdog
docker compose exec -T n8n n8n list:workflow | grep -E '01-email-pipeline-main.*active'
```

If the reactivation does not happen, inspect the watchdog execution log in the n8n UI and file the issue — this is the failure mode STATE.md flagged as an open blocker.
</action>
<read_first>
  - n8n/workflows/02-imap-watchdog.json
</read_first>
<acceptance_criteria>
- After simulated deactivation + wait cycle, `docker compose exec -T n8n n8n list:workflow | grep -c '01-email-pipeline-main.*active'` returns at least `1`
- n8n UI execution log shows at least one watchdog execution during the wait window
</acceptance_criteria>
</task>

</tasks>

<verification>
```bash
# 1. Both workflows imported and active
docker compose exec -T n8n n8n list:workflow | tee /tmp/wf.txt
grep -q '01-email-pipeline-main' /tmp/wf.txt
grep -q '02-imap-watchdog' /tmp/wf.txt

# 2. Workflow JSON files committable (no inline credentials)
! grep -r -l 'password\|accessToken\|refreshToken' n8n/workflows/*.json

# 3. Test email lands in mailbox.email_raw within 90s (measured in task 6)
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT COUNT(*) FROM mailbox.email_raw WHERE subject LIKE '%smoke%';
" | grep -q -v '^0$'

# 4. Watchdog recovered a simulated dead trigger (measured in task 7)
# (manual verification — recorded in n8n execution log)

# 5. email_raw row shape includes thread headers per D-24
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT COUNT(*) FROM mailbox.email_raw
  WHERE message_id IS NOT NULL AND received_at IS NOT NULL;
" | grep -vq '^0$'
```
</verification>
