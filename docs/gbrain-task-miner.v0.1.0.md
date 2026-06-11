# gBrain Task Miner — Tasks from Memory (Human → Linear, Agent → Kanban)

**Version:** v0.1.0 · **Date:** 2026-06-11 · **Status:** v1 implemented (this PR)
**Depends on:** gbrain ingest expansion (PR #89, merged), Conversations/meeting
notes (PR #92, merged), Tasks provider + Linear-UX layer (PR #66/#93, live).

**TL;DR:** A scheduled agent job mines newly-ingested gbrain pages (meeting
notes, feedback, calendar, agent outcomes) for actionable commitments and
routes them by executor: **agent-doable → native kanban triage** (where
auto-decompose + the dispatcher already take over) and **human → Linear**
(Triage state, team taken from the operator's Tasks-tab selection). Both
targets are propose-only states — nothing executes or schedules without a
human (or the orchestrator profile) promoting it.

## Routing rule (the core decision)

| Owner kind | Destination | Why |
|---|---|---|
| Agent-doable | kanban `triage` via `kanban_create` | Execution queue already solved: auto-decompose routes to a profile, dispatcher runs it, idempotency_key dedupes |
| Human | Linear issue (Triage) | Kanban is an execution queue — auto-decompose would chew human tasks into agent subtasks. Linear is the human tracker (MBOX) |

## v1 architecture — config-only agent job + one new endpoint

1. **Agent Job template** (`gbrain-task-miner` in `hermes_cli/agent_templates.py`,
   shows in Agent Jobs → templates): pre-fills a cron job (default `every 6h`,
   box-default local model, kanban toolset enabled) with the miner prompt.
2. **Miner prompt protocol** (encoded in the template):
   - Recall gbrain pages changed since the last run (meeting notes, feedback,
     calendar, agent outcomes).
   - Extract candidates: `{title, why, source_page, owner_kind, confidence}`;
     drop confidence < 0.6.
   - **Dedupe ledger:** `~/.hermes/task-miner/mined.jsonl` — one line per
     created task `{source_page, title_hash, dest, ref, ts}`; read before
     creating, append after. Kanban side is double-guarded by
     `idempotency_key = "miner:" + sha1(source_page + "|" + normalized_title)[:16]`.
   - Agent → `kanban_create(triage=true, body=why + source link, idempotency_key)`.
   - Human → `POST /api/linear/... ` is auth-gated, so the job calls **Linear
     GraphQL directly** (`issueCreate`) with `LINEAR_API_KEY` from the
     environment (fallback: `~/.hermes/.env`). Team id comes from the
     operator's pick persisted in `~/.hermes/tasks-prefs.json`
     (`linear_team_id`); if unset, the job creates nothing on the Linear side
     and reports that the operator must pick a team in Operations → Tasks →
     Linear.
   - Caps: ≤ 10 creations per run (5 per destination); excess reported, not
     created. Run report lists created/skipped/deferred with source links.
3. **Dashboard write endpoint** `POST /api/tasks/linear/issues` (web_server.py,
   session-gated): `{team_id, title, description?, priority?}` →
   `issueCreate` via the existing `_linear_graphql` client → `{id, identifier,
   url}`; busts the Linear board cache so the Tasks tab reflects it. v1
   consumer is the dashboard/operator (and any future deterministic miner);
   the agent job itself talks GraphQL directly (no session token in cron).
4. **Key visibility fix:** `LINEAR_API_KEY` recategorized in `config.py`
   (`skill` → `integration`, non-advanced) — the Settings → Keys page never
   rendered the `skill` category, which is why the key was un-settable from
   the dashboard.

## Safety

- Propose-only: miner writes only to triage states; it never promotes,
  assigns to running, or unblocks.
- Idempotent by construction (ledger + kanban idempotency keys); safe to
  re-run, safe after crashes.
- No secrets in task bodies; source references are gbrain page ids/links.
- Per-run creation caps prevent a bad extraction from flooding both trackers.

## v2 (deferred)

Deterministic extractor (systemd timer like the `gbrain-ingest/` pipelines:
state file, one LLM call per new page, explicit JSON contract), per-source
confidence tuning, due-date extraction into the kanban-meta sidecar,
WhatsApp run-summary notification, Linear label `from-gbrain`.

## Acceptance (v1)

- Template appears in Agent Jobs and instantiates a job with the miner prompt.
- `POST /api/tasks/linear/issues` creates a real Linear issue and returns its
  identifier/url (manual smoke once LINEAR_API_KEY is set).
- LINEAR_API_KEY visible + settable in Settings → Keys.
- `py_compile` + script `bash -n` gates green; no `plugins/` changes.
