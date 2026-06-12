# Org Chart Tasks — Selectable Task Provider (Native | Linear)

**Version:** v0.1.0 · **Date:** 2026-06-10 · **Status:** Implemented (this PR)

**TL;DR:** The Org Chart > Tasks sub-tab currently hard-embeds the bundled
`/kanban` plugin. This adds a provider selector — **Native** (kanban plugin,
default) or **Linear** — persisted server-side, plus a read-only Linear board
(issues grouped by workflow state, with a team picker and deep links into
Linear) served by the custom dashboard backend using the existing
`LINEAR_API_KEY` env slot.

## Problem

The operator runs real work in Linear (staqs workspace), but the dashboard's
Tasks view only shows the appliance-local kanban SQLite board. There is no way
to see Linear work from the Org Chart workspace.

## Scope (v1)

- Provider preference persisted at `~/.hermes/tasks-prefs.json`
  (`{provider: "native"|"linear", linear_team_id: string|null}`), mirroring the
  digest-prefs pattern.
- `GET/PUT /api/tasks/prefs` — read/update preference; response also carries
  `linear_configured` so the UI can render a setup hint.
- `GET /api/tasks/linear/teams` — team list for the picker.
- `GET /api/tasks/linear/board?team=<id>` — issues (first 100, most recently
  updated) grouped into Triage / Backlog / Todo / In Progress / Done columns by
  Linear workflow-state *type*. Canceled excluded; Done limited to the last
  14 days. 60s in-process cache per team; `refresh=1` busts it; stale cache is
  served on upstream errors.
- Frontend: `OrgTasks` component replaces the direct `PluginPage` embed in
  `OrgChartPage`. Segmented Native | Linear switcher; Linear view adds team
  select + refresh. The Tasks tab now always renders (previously hidden when
  the kanban plugin was absent — Linear can carry it alone).
- Auth: `LINEAR_API_KEY` read from process env, falling back to
  `~/.hermes/.env` via `load_env()`. Set it in **Settings → Keys** — no new
  credential storage.

## Out of scope (v2 candidates)

- Writes to Linear (create issue, drag-to-change-state).
- Per-team-member task rollups on the org graph.
- Mapping kanban tenants ↔ Linear projects.
- Additional providers (ClickUp, Google Tasks).

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Preference storage | JSON file in `~/.hermes/` | Matches digest-prefs; single-operator appliance, no DB needed |
| Selector placement | Inline in the Tasks sub-tab | That's where the choice is exercised; no Settings round-trip |
| Linear v1 read-only | Yes | Smallest correct change; write path needs UX + error design |
| Column model | Group by state *type*, not state name | Stable across teams with custom workflows |
| API key | Reuse `LINEAR_API_KEY` (`hermes_cli/config.py`) | Slot already exists for the `linear` skill; one key, one place |

## Assumptions (flag if wrong)

- One Linear workspace per appliance (whatever the API key sees).
- Read-only is acceptable for v1.
- "Native" remains the default provider until switched.
