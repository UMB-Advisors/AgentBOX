# Processed-Message Dedup via n8n Data Table

**Status:** apply-ready artifacts (NOT yet applied to live). The Data Table node ships in the
binary on the live box (n8n 2.14.2, `mailbox-n8n-1`) but the **data-table backend module is not
active in any process I can drive non-interactively**, so the table could not be created from the
CLI. See "Why this wasn't applied on live" below. Apply via the n8n UI (works on 2.14.2 today) or
on the 2.25.7 instance once prod upgrades.

**Last verified on live:** 2026-06-11. `data_table` / `data_table_column` both 0 rows (unchanged
by this investigation). No live workflow was mutated.

---

## TL;DR

- Dedup key = `(account_id, provider_message_id)` where `provider_message_id` = `inbox_messages.message_id`
  (provider/Gmail id) and `account_id` comes from `inbox_messages.account_id` (known-correct; do NOT
  read it from the draft stub — the stub defaults to placeholder account 1).
- Create a Data Table `processed_messages` with 3 columns: `account_id` (Number),
  `provider_message_id` (String), `ingested_at` (String, ISO).
- Wire a **read gate** (`row:rowNotExists`) into `MailBOX-Classify` (id `MlbxClsfySub0001`)
  right after `Load Inbox Row`, before `Build Prompt`. If the row already exists, the branch emits
  nothing and the LLM/draft path never runs (short-circuits LLM cost).
- Wire a **write** (`row:upsert`, keyed on both columns) right after `Insert Draft Stub` so only
  fully-processed messages get marked.
- Deploy the workflow edit only via the documented path
  (export → edit → `import:workflow` → `update:workflow --active=true` → restart container).

---

## Why the Data Table node IS available but COULDN'T be created from the CLI

Findings from introspecting `mailbox-n8n-1` (n8n 2.14.2):

1. **Node binary present, not license-gated.** `n8n-nodes-base/dist/nodes/DataTable/` exists;
   `@BackendModule({ name: 'data-table' })` carries **no `licenseFlag`**; `data-table` is in the
   registry's `defaultModules` list and in `MODULE_NAMES`. Neither `N8N_ENABLED_MODULES` nor
   `N8N_DISABLED_MODULES` is set, so by `eligibleModules` logic the module is eligible on the main
   server.
2. **But `n8n execute` (CLI) never inits modules.** Running the create through `n8n execute --id=...`
   — even with `N8N_ENABLED_MODULES=data-table` forced — fails with:
   `Attempted to use Data table node but the module is disabled`
   (`getDataTableAggregateProxy`: `ctx.helpers.getDataTableAggregateProxy === undefined`).
   The CLI execute path runs a minimal engine that never calls `ModuleRegistry.initModules()`,
   so the data-table helpers proxy is permanently undefined in that process. The CLI is the wrong
   vehicle regardless of env flags.
3. **The authenticated REST/public API needs a key.** `/api/v1/data-tables` → 401; `/rest/*` needs a
   browser session cookie. No API key is provisioned and I will not mint credentials on a live box.
4. **Raw-SQL creation is unsafe.** A Data Table is metadata in `data_table` + `data_table_column`
   (FK to `project`) PLUS a runtime-created backing table named
   `${tablePrefix}data_table_user_<dataTableId>` (from `toTableName()` in
   `modules/data-table/utils/sql-utils.js`). Hand-rolling all three with n8n's exact column DSL and
   id/index conventions bypasses the app layer and risks corrupting the module's view of the table.
   Rejected.

**Net:** the only supported creation paths that actually init the module are the **n8n UI** or the
**authenticated API** — both run inside the long-lived server process. Use the UI step below.

---

## (a) Schema — Data Table `processed_messages`

| Column                | n8n type | Source                                  | Notes |
|-----------------------|----------|-----------------------------------------|-------|
| `account_id`          | Number   | `inbox_messages.account_id`             | known-correct; not from draft stub |
| `provider_message_id` | String   | `inbox_messages.message_id` (Gmail id)  | ~40-char provider id |
| `ingested_at`         | String   | `now()` ISO 8601                        | String (not Date) to avoid date coercion in the write path |

Logical unique key: `(account_id, provider_message_id)`. n8n Data Tables have **no native unique
constraint** — enforce idempotency by using `upsert` on the write (match both columns) and the
`rowNotExists` gate on the read.

System columns `id`, `createdAt`, `updatedAt` are added automatically; do not define them.

### Create it (n8n UI — works on live 2.14.2 today)

1. Open the n8n UI (project: `Dustin Powers <consultingfutures@gmail.com>`, the only project).
2. Data Tables → New → name `processed_messages`.
3. Add columns exactly: `account_id` (Number), `provider_message_id` (String),
   `ingested_at` (String). Save.
4. Copy the new table's **ID** (you'll paste it into the node configs below as `dataTableId`).

> Alternative (also UI-equivalent, runs in the server): drop a temporary workflow with a Manual
> Trigger → Data Table node (`resource: table`, `operation: create`) using
> `processed-message-dedup.nodes.json`'s `__create_table__` node, click **Test workflow** once, then
> delete the temp workflow. Do NOT use `n8n execute` for this — it will report the module disabled.

---

## (b) Node configs to add to `MailBOX-Classify` (id `MlbxClsfySub0001`)

Exact JSON in `processed-message-dedup.nodes.json` (this directory). Two nodes:

### Read gate — `Dedup Gate` (`row:rowNotExists`)
- Insert **after** `Load Inbox Row`, **before** `Build Prompt`.
- Rewire: `Load Inbox Row.main[0]` → `Dedup Gate`; `Dedup Gate.main[0]` → `Build Prompt`.
- Behavior: `rowNotExists` emits the input item only when NO matching row exists. If the message was
  already processed, it emits nothing → the entire downstream chain (Build Prompt → Call Ollama →
  Insert Classification Log → Insert Draft Stub → draft sub) never runs. This is the LLM-cost
  short-circuit.
- Filter: `matchType = allConditions` (AND), two conditions:
  - `account_id` `eq` `={{ $json.account_id }}`
  - `provider_message_id` `eq` `={{ $json.message_id }}`
- **Source the values from `Load Inbox Row` output** (`inbox_messages` row), which has the correct
  `account_id` and the provider `message_id`.

### Write — `Mark Processed` (`row:upsert`)
- Insert **after** `Insert Draft Stub` (success path), before / parallel to `Pack Draft Id`.
  Recommended: `Insert Draft Stub.main[0]` → `Mark Processed` → `Pack Draft Id` (keep the existing
  chain order; just splice in between).
- Operation `upsert`, matching on `account_id` + `provider_message_id` (idempotent on re-runs and on
  the concurrency race below).
- Values written:
  - `account_id` = `={{ $('Load Inbox Row').item.json.account_id }}`
  - `provider_message_id` = `={{ $('Load Inbox Row').item.json.message_id }}`
  - `ingested_at` = `={{ $now.toISO() }}`
- **Always reference `Load Inbox Row` for account_id/message_id**, never the draft-stub output
  (the stub's `account_id` defaults to placeholder `1` — the known bug). Sourcing from
  `inbox_messages` keeps the dedup record correct.

> Replace `PASTE_DATA_TABLE_ID_HERE` in both nodes with the real table id from step (a).
> The `dataTableId` resourceLocator also accepts `mode: "name"` with value `processed_messages`
> (lower-cased lookup) if you prefer not to hardcode the id.

---

## (c) Deploy steps (documented path — do NOT edit `workflow_entity` directly)

This n8n keeps DRAFT vs PUBLISHED versions; direct SQL edits to `workflow_entity.nodes` never
execute. The scheduler/runner uses `activeVersionId` → `workflow_history`.

```
# 1. Export the PUBLISHED workflow to inspect/edit
docker exec mailbox-n8n-1 n8n export:workflow --id=MlbxClsfySub0001 --output=/tmp/classify.json

# 2. Pull it out, splice in the two nodes from processed-message-dedup.nodes.json,
#    add the connection rewires (Load Inbox Row -> Dedup Gate -> Build Prompt;
#    Insert Draft Stub -> Mark Processed -> Pack Draft Id), set dataTableId.

# 3. Re-import and publish
docker exec mailbox-n8n-1 n8n import:workflow --input=/tmp/classify.json
docker exec mailbox-n8n-1 n8n update:workflow --id=MlbxClsfySub0001 --active=true

# 4. Restart the container so the active version is picked up
docker restart mailbox-n8n-1
```

After restart, send/poll a known-duplicate message and confirm it does NOT produce a second draft;
confirm `processed_messages` gains exactly one row per unique `(account_id, provider_message_id)`.

---

## Retention / cap

- Hard cap: `DataTableConfig.maxSize = 50 MB` (`52428800` bytes), overridable via
  `N8N_DATA_TABLES_MAX_SIZE_BYTES`; set `N8N_DATA_TABLES_WARNING_THRESHOLD_BYTES` for early warning.
- Each row ~60-80 bytes of payload + overhead → 50 MB holds >100k rows (current volume is ~160 msgs),
  so this is not an immediate concern. Still, add a retention cron (Data Table `row:deleteRows`
  filtering `ingested_at` older than e.g. 90d) to keep it bounded — otherwise once the table fills,
  dedup writes silently start failing.

---

## Risks (carry-over + confirmed)

- **No native uniqueness.** Concurrent classify runs for the same message could both pass the
  `rowNotExists` gate and double-insert. Mitigated by using `upsert` on the write (match both
  columns) + the existing single-writer ingestion cadence. Not fully race-proof.
- **account_id=1 placeholder bug.** Always source `account_id`/`message_id` from `Load Inbox Row`
  (`inbox_messages`), never the draft stub.
- **CLI cannot drive the module.** Table creation and any test of the dedup nodes must run inside the
  live server (UI / API / activated workflow), not `n8n execute`.
- **Version pinning.** Node is v1/1.1 in 2.14.2. If the box OTA-updates to 2.25.7 (GA Data Tables),
  re-verify node version and that the filter/resourceMapper parameter shapes still match before
  assuming the spliced workflow still runs.
- **Deploy hazard.** Edits to `MailBOX-Classify` must go through
  export → import:workflow → update:workflow --active=true → restart, or the dedup check won't run.
