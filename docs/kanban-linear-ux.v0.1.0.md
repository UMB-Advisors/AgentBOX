# Kanban Linear-UX — Migrating Crucial Linear Features onto the Native Tracker

**Version:** v0.1.0 · **Date:** 2026-06-10 · **Status:** Approved for build
**Builds on:** `docs/orgchart-tasks-provider.v0.1.0.md` (PR #66 — provider selector)

**TL;DR:** The native hermes kanban is already the stronger tracker (durable
SQLite board, agent dispatcher, auto-decompose, runs/handoffs). What it lacks
is Linear's planning layer and keyboard-first UX. This spec ports the crucial
parts in three phases — all implemented in layers WE own (`web/src` +
`hermes_cli/web_server.py`), never in `plugins/` (prebuilt upstream code that
`hermes update` would clobber and that our deploy pipeline doesn't ship).

---

## Architecture constraints (read first, non-negotiable)

1. **Never modify `plugins/kanban/`** — the plugin frontend is a prebuilt dist
   from stock hermes (source not vendored) and `plugin_api.py` is not in the
   custom-backend deploy set (`bin/lib/custom-backend-files.sh` ships
   `hermes_cli/*.py` only). All new UI goes in `web/src`; all new backend goes
   in `hermes_cli/web_server.py`.
2. **The plugin's REST API is the data plane.** Read/write tasks through
   `/api/plugins/kanban/*` (same-origin; `HomePage.tsx` and `api.ts` already
   call it). Verify field semantics against `hermes_cli/kanban_db.py` before
   relying on them (especially priority ordering).
3. **Linear-only metadata lives in a sidecar store**, not the plugin DB:
   `~/.hermes/kanban-meta.json`, served by new web_server.py endpoints
   (pattern: `_DIGEST_PREFS_FILE` / `tasks-prefs.json`). The plugin UI won't
   display sidecar fields — that's accepted; they render in OUR views only.
4. **Build gates:** `cd web && npm run build` (tsc -b + vite) and
   `python3 -m py_compile hermes_cli/web_server.py` must pass before every
   commit. Atomic commits, Commit Engine style, no co-author line. Never push,
   never deploy, never touch the boxes.
5. TypeScript: interfaces over types, no `any` (use `unknown` + narrowing),
   discriminated unions for state variants. Match existing component style
   (`@nous-research/ui` kit: Badge uses `tone=`, Button supports `ghost`).

## Existing surface being extended

- `web/src/components/OrgTasks.tsx` — Org Chart > Tasks provider switcher
  (Native = `<PluginPage name="kanban">` embed | Linear = read-only board).
  This spec extends the **Native** side.
- Kanban REST (FastAPI router mounted at `/api/plugins/kanban`):
  - `GET /board` → `{ columns: [{name, tasks: [...]}], assignees, tenants,
    total, done, latest_event_id, now }`. Columns:
    `triage, todo, scheduled, ready, running, blocked, review, done`
    (+ archived via toggle). Task dict = `kanban_db.Task` asdict + `age`
    metrics + `latest_summary` (~200-char preview) + `parents`/`children`.
  - `POST /tasks` — `CreateTaskBody { title, body?, assignee?, tenant?,
    priority=0, workspace_kind="scratch", workspace_path?, parents=[],
    triage=false, idempotency_key?, max_runtime_seconds?, skills? }`
  - `PATCH /tasks/{id}` — `UpdateTaskBody { status?, assignee?, priority?,
    title?, body?, result?, block_reason?, summary?, metadata? }`
  - `POST /tasks/bulk` — `{ ids, status?, assignee?, priority?, archive?,
    reclaim_first? }`
  - `GET /assignees`, `GET /tasks/{id}`, `POST /tasks/{id}/comments`
    (`{body, author}`), `POST /links` (`{parent_id, child_id}`),
    `GET /stats`, `WS /events?since=` (live refresh signal).
  - All endpoints accept `?board=` (multi-board); v1 of this spec targets the
    current board only (omit the param).
- `web/src/lib/api.ts` — add typed client fns here (existing `getKanbanBoard`
  + `KanbanBoard`/`KanbanTask` types are the loose starting point; tighten
  KanbanTask with the fields the new views need, keeping `[k: string]:
  unknown` for forward-compat).

## Sidecar store — `~/.hermes/kanban-meta.json`

```jsonc
{
  "version": 1,
  "tasks": {
    "<task_id>": {
      "due_at": "2026-06-14",        // ISO date (no time); null/absent = none
      "labels": ["l-infra"],          // label ids
      "estimate": 3,                  // points, positive int
      "cycle_id": "c-2026-w25"
    }
  },
  "labels":  [{ "id": "l-infra", "name": "infra", "color": "#6366f1" }],
  "cycles":  [{ "id": "c-2026-w25", "name": "Cycle 1", "start": "2026-06-15", "end": "2026-06-28" }],
  "views":   [{ "id": "v-...", "name": "My queue", "filters": { /* FilterState, see Phase 2 */ } }]
}
```

Backend endpoints (web_server.py, mirror digest-prefs read/merge/write style;
single-operator appliance → no locking beyond atomic write):

- `GET  /api/tasks/meta` → whole doc (defaults merged).
- `PUT  /api/tasks/meta` → body may carry `labels`, `cycles`, `views`
  (full-array replace per key, validated); returns doc.
- `PATCH /api/tasks/meta/tasks/{task_id}` → merge one task's entry
  (`{due_at?, labels?, estimate?, cycle_id?}`; `null` clears a field; entry
  removed when all fields cleared); returns the entry.
- Validation: `due_at` ISO date; `estimate` int 0–100; label/cycle ids must
  exist in their arrays; unknown keys rejected 400. Reads tolerate a corrupt
  file (log + defaults), like `_read_digest_prefs`.

---

## Phase 1 — Linear feel (pure frontend)

**Goal:** the native Tasks view stops being "an embedded plugin" and starts
feeling like Linear: scannable list, instant keyboard capture, Cmd+K.

### 1.1 Native sub-views: Board | List

`OrgTasks.tsx` native branch gains a small toggle (same segmented-control
style as the provider switcher): **Board** (existing `PluginPage` embed,
unchanged) and **List** (new `web/src/components/KanbanListView.tsx`).
Last-used sub-view persists in `localStorage` (UI-only state; no backend).

### 1.2 List view (`KanbanListView.tsx`)

- Data: `GET /api/plugins/kanban/board` (one call has every column), refetch
  on mutation + 30s polling (skip WS plumbing in v1; note as future).
- Grouped rows, Linear-style: group-by selector **Status (default) |
  Assignee | Priority**. Group header: name + count.
- Row: priority indicator, task id (short), title (truncate), assignee,
  comment count, age (use provided `age` metrics; humanize like `isoTimeAgo`
  in `lib/utils`), status pill when not grouping by status.
- Row interactions: click → detail panel (right-side sheet, ours, read +
  quick edits: status select, priority select, assignee select, link "open
  Board view"); checkbox multi-select → bulk bar (status / priority /
  assignee via `POST /tasks/bulk`).
- Sort within group: priority desc, then age asc. Verify priority ordering
  semantics in `kanban_db.py` first and encode the finding in a comment.
- Empty/error states per house style (Card + muted text).

### 1.3 Quick-add bar

Input pinned above the list (and board) — placeholder shows the grammar.
Parse on submit → `POST /tasks`:

| Token | Maps to | Notes |
|---|---|---|
| bare words | `title` | required |
| `!0`–`!3` or `!urgent !high !medium !low` | `priority` | verify int↔urgency direction in kanban_db; map aliases accordingly |
| `@name` | `assignee` | validate against `GET /assignees`; unknown → inline error, don't create |
| `#tenant` | `tenant` | free-form |
| `>taskid` | `parents: [id]` | optional, repeatable |
| `?` (leading) | `triage: true` | "rough idea" flag |
| `due:YYYY-MM-DD` | sidecar `due_at` (Phase 2; parser accepts + stores from Phase 2 on; in Phase 1 parse and ignore with a toast "due dates land in Phase 2") |

Parser is a pure function in `web/src/lib/quickAdd.ts` with unit-testable
shape (export `parseQuickAdd(input): { body: CreateTaskBody-ish, dueAt?:
string, errors: string[] }`). Escape hatch: quoted segments stay in title.

### 1.4 Command palette (Cmd+K)

`web/src/components/CommandPalette.tsx`, mounted inside OrgTasks (scoped to
the Tasks tab, not global nav — keep blast radius small). Overlay + fuzzy
filter (simple subsequence match, no new deps).

- Sources: **actions** (New task → focuses quick-add; Switch to Board/List;
  Group by …; Refresh) and **tasks** (from the loaded board; select → opens
  detail panel).
- With a task selected (palette opened via row focus or after task pick):
  Set status → submenu of the 8 statuses; Set priority; Assign to →
  assignees list; Archive (confirm); Comment (inline input → POST comment).
- Keyboard map (list view, no palette open): `↑/↓` move focus, `Enter` open
  detail, `x` toggle select, `s` status submenu, `p` priority, `a` assignee,
  `c` comment, `/` focus quick-add, `Cmd/Ctrl+K` palette. Document the map in
  a `?` help popover. No global listener leaks — handlers attach within the
  Tasks tab and clean up on unmount.

**Phase 1 exit criteria:** list renders real board data grouped 3 ways; a
task created via quick-add with `!`/`@`/`#` tokens appears correctly in both
List and the plugin Board; palette can change status/priority/assignee on a
task and the plugin Board reflects it after refresh; `npm run build` green.

---

## Phase 2 — Saved views & due dates

**Goal:** persistent filters and real deadlines.

### 2.1 Filter model + chips

```ts
interface FilterState {
  statuses: string[];      // empty = all
  assignees: string[];
  tenants: string[];
  labels: string[];        // used from Phase 3
  cycleId: string | null;  // used from Phase 3
  text: string;
  overdueOnly: boolean;
}
```

- Chip bar above the list: built-ins **All · Active** (todo+scheduled+ready+
  running+blocked+review) **· Triage · Blocked · Done** + user-saved views.
- "Save view" (name prompt) → `PUT /api/tasks/meta` views array; delete via
  chip context action. Active view highlights; ad-hoc edits show a dirty dot
  with "update view / save as new".
- Filters apply client-side to the loaded board (≤ a few hundred tasks on an
  appliance — no server filtering needed; note ceiling in code comment).

### 2.2 Due dates (sidecar)

- Implement the sidecar store + endpoints (schema above) in web_server.py.
- Detail panel gains a due-date field; quick-add `due:` now persists (PATCH
  meta after task create returns the id).
- List row shows due badge: amber when due ≤ 48h, red + "overdue" when past
  (date-only comparison, local tz). `overdueOnly` filter + an **Overdue**
  built-in chip appear when any task has a due date.
- Limitation (accepted): plugin Board view never shows due dates.
- GC: when the board fetch shows a sidecar task id no longer exists, prune
  its entry on next meta write (lazy, client-triggered via a `prune: [ids]`
  field on PUT — server validates ids absent from… simpler: server-side
  prune on PUT when `prune_missing: true` and client passes the live id
  list. Keep it simple and documented.)

**Phase 2 exit criteria:** a saved view survives reload (file-backed); due
date set in detail panel survives reload and renders overdue correctly;
py_compile + npm build green.

---

## Phase 3 — Labels, estimates, cycles (lite)

**Goal:** the planning layer — without forking the plugin schema.

### 3.1 Labels

- Label CRUD (name + color from a fixed 8-swatch palette) in a small
  "Manage labels" dialog reachable from the filter bar.
- Multi-assign per task (detail panel + palette "Add label"). Quick-add
  token: `*label` (created on the fly if unknown? No — unknown label = inline
  error with "create label" shortcut; explicit beats implicit).
- Chips on list rows; label filter in FilterState + chip bar dropdown.

### 3.2 Estimates

- `est:N` quick-add token + detail-panel field (points, 0–100).
- List shows points right-aligned; group headers show summed points
  (done vs total when grouping by status… keep: total only).

### 3.3 Cycles (lite)

- Cycle CRUD (name, start date, end date) in a "Cycles" dropdown next to the
  filter bar; current cycle = today within [start, end].
- Assign task→cycle via detail panel / palette / quick-add `cycle:<name>`.
- Cycle filter; dropdown shows per-cycle progress: `done/total tasks ·
  done/total points` with a thin progress bar. No burn-up charts, no
  auto-rollover (v2 candidates).

**Phase 3 exit criteria:** label + estimate + cycle set on a task all
survive reload; cycle progress reflects task completion after a status
change; all builds green.

---

## File map (expected; agents may add small helpers)

| File | Phase | Change |
|---|---|---|
| `web/src/components/OrgTasks.tsx` | 1 | Board/List toggle, quick-add mount, palette mount |
| `web/src/components/KanbanListView.tsx` | 1 | new — list view + detail panel + bulk bar |
| `web/src/components/CommandPalette.tsx` | 1 | new |
| `web/src/lib/quickAdd.ts` | 1 | new — parser (pure) |
| `web/src/lib/api.ts` | 1–3 | typed kanban mutations + meta client |
| `web/src/components/KanbanFilterBar.tsx` | 2 | new — chips, saved views, label/cycle dropdowns (3) |
| `hermes_cli/web_server.py` | 2 | sidecar store + `/api/tasks/meta*` endpoints |
| `docs/kanban-linear-ux.v0.1.0.md` | — | this spec; append addendums, don't rewrite |

## Out of scope (all phases)

Modifying `plugins/`, plugin Board UI changes, WS live updates for our views,
multi-board support, burn-up/velocity charts, auto-rollover cycles, Linear
two-way sync, per-member org-graph rollups, deploys.
