# Org Chart Tab — Spec v0.1.0

**Date:** 2026-06-09
**Target:** hermes web dashboard (`web/`, agentbox2, :9119/:9120) + mailbox-dashboard CRM backend (:3001)
**Status:** approved (architecture decisions locked with operator), implementing

## TL;DR
A single **Org Chart** destination consolidates the org-facing surfaces that are
today four separate left-nav tabs. It lives as a left-nav item grouped at the
bottom (above Settings) and opens a full page with internal sub-tabs:
**Team · Graph · Tasks · Agent Jobs**. The **Graph** sub-tab is new — an
interactive reporting-hierarchy visualization built on React Flow, driven by a
new `reports_to` field on team members. Team, Tasks, and Agent Jobs are the
existing pages, re-homed here and removed from the primary left nav.

## Decisions (locked)
1. **Placement:** left-nav item, grouped at the bottom near Settings. Full-page
   destination at route `/org`, with an internal sub-tab bar.
2. **Consolidation:** remove standalone `Team` (`/team`), `Tasks` (`/kanban`),
   and `Agent Jobs` (`/cron`) from the primary nav; surface them as sub-views
   inside Org Chart. `Contacts` and `Brain Graph` (`/graph`) stay standalone.
   Underlying routes (`/team`, `/cron`, `/kanban`) remain registered so deep
   links keep working; only the nav entries move.
3. **Graph edges:** add a real reporting hierarchy. New nullable
   `team_members.reports_to` (self-FK). The graph renders CEO → managers →
   reports. Members with no manager are roots; department is shown as node
   metadata / optional grouping, not the primary edge.

## Backend changes (mailbox-dashboard)
- **Migration** `050-add-team-reports-to-v1-2026-06-09.sql`:
  `ALTER TABLE mailbox.team_members ADD COLUMN IF NOT EXISTS reports_to INTEGER
  REFERENCES mailbox.team_members(id) ON DELETE SET NULL;` (idempotent, additive).
- **`lib/crm/queries.ts`:** add `reports_to` to `TeamMember`, `TeamInput`,
  the INSERT column list, and the UPDATE `add()` set.
- **`app/api/crm/team/route.ts`** (`readTeamInput`) and
  **`team/[id]/route.ts`** (`readPatch`): parse `reports_to` (null | int).

## Frontend changes (web/)
- **`src/lib/crm.ts`:** add `reports_to: number | null` to `TeamMember` and
  `reports_to?: number | null` to `TeamInput`.
- **`src/pages/TeamPage.tsx`:** add a "Reports to" manager `<Select>` to the
  create/edit form (options = other team members; excludes self on edit).
- **`src/pages/OrgChartPage.tsx`** (new): page shell with a sub-tab bar. Mounts
  exactly one sub-view at a time: `TeamPage`, `TeamGraph`, the `/kanban`
  `PluginPage` (only if the plugin manifest is present), `CronPage`. Sets the
  page header title to "Org Chart".
- **`src/components/TeamGraph.tsx`** (new): React Flow org chart. Fetches team +
  departments via `crmApi`, builds a layered tree from `reports_to` (simple
  top-down layout, no extra layout dep), themes nodes via existing CSS vars,
  human vs agent styled distinctly. Pan/zoom + minimap + fit-view.
- **`src/App.tsx`:** import `OrgChartPage` + a `Sitemap`-style icon; register
  `/org` in `BUILTIN_ROUTES_CORE`; in `buildPrimaryNav` drop the `/team`,
  `/kanban`, and `/cron` entries and add `{ path: "/org", label: "Org Chart" }`
  immediately before Settings.
- **Dependency:** add `@xyflow/react` (React Flow v12).

## Non-goals (v0.1.0)
- Drag-to-reassign manager in the graph (edit via Team form for now).
- Department-swimlane layout (metadata only this version).
- Writing org structure back to gbrain / Brain Graph.

## Verification
- `npm run build` (tsc + vite) passes.
- Nav shows Org Chart near the bottom; Team/Tasks/Agent Jobs gone from primary nav.
- Org Chart sub-tabs render the four views; Graph draws a hierarchy once a
  member has a `reports_to` set.
