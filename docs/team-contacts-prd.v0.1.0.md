# PRD — Team, Contacts & Job Assignment (AgentBOX dashboard)

**Version:** 0.1.0
**Date:** 2026-06-04
**Status:** Draft — awaiting architecture sign-off before build

## TL;DR
Add two CRM-style tabs to the AgentBOX dashboard — **Team** (humans + agents in the
company) and **Contacts** (phone / email / social) — backed by the on-box **Postgres**,
readable by both the **hermes dashboard** and **gbrain**. Also let each **Scheduled Action
(cron job)** be assigned a **Department** and an **Employee** (a Team member).

## Goals
1. **Team tab** — CRUD list of members. Fields: name, kind (human | agent), title/role,
   department, email, status (active/inactive), notes. (Agents = manual entry in v1.)
2. **Contacts tab** — CRUD list. Fields: name, company, phones[], emails[],
   socials[] (platform + handle/url), notes, tags.
3. **Per-job Department + Employee** — assign on create/edit of a Scheduled Action;
   shown on the job card. Employee = dropdown of Team members; Department = managed list.
4. **Shared store** — data lives in Postgres so gbrain can read it too.

## The constraints that shape this (verified 2026-06-04)
- Postgres runs as `mailbox-postgres-1` (db `mailbox`, user `mailbox`), **internal docker
  network only** — not reachable from the host where the hermes dashboard runs.
- The **hermes dashboard venv has no Postgres driver** (no psycopg/asyncpg). Adding one is
  possible but a `hermes update` rebuilds the venv, so it must be re-applied post-update.
- The **mailbox-dashboard** (Node) is *already* connected to this Postgres and is *already*
  reverse-proxied by the hermes dashboard at `/dashboard/*` (the Incoming Messages tab uses it).
- **gbrain** currently stores in **PGLite** (`~/.gbrain/brain.pglite`), not this Postgres.

## Architecture decision (NEEDS SIGN-OFF) — where does the CRUD/DB code live?
**Option A — extend mailbox-dashboard (Node), surface in hermes dashboard. [Recommended]**
mailbox-dashboard already owns Postgres + migrations + is proxied. Add `team`/`contacts`/
`departments` tables + REST routes there; the hermes dashboard renders the tabs (native React
pages calling the proxied `/dashboard/api/...`, like the inbox). gbrain reads the same tables.
*Pros:* reuses DB wiring, survives hermes updates, one DB owner. *Cons:* feature spans the
mailbox repo (not just HermesBOX).

**Option B — connect the hermes dashboard directly to Postgres.**
Publish Postgres on loopback (override `127.0.0.1:5433:5432`), add psycopg to the hermes venv,
write CRUD endpoints in `web_server.py`. *Pros:* fully native to the hermes dashboard. *Cons:*
new venv dependency (re-install after each `hermes update`; extend deploy script), second DB
client against the appliance DB.

**Recommendation:** Option A — least fragile, reuses proven patterns.

## Data model (Postgres, schema `agentbox`)
- `agentbox.departments(id, name UNIQUE, created_at)`
- `agentbox.team(id, name, kind, title, department_id→departments, email, status, notes,
  timestamps)`
- `agentbox.contacts(id, name, company, phones jsonb, emails jsonb, socials jsonb, tags
  jsonb, notes, timestamps)`
- Cron assignment: cron jobs are JSON-file storage (`~/.hermes/cron/jobs.json`), not Postgres —
  so store `department` + `employee_id` as job fields (via the existing `update_job` updates
  dict + extend `create_job`), and resolve the Employee label from `agentbox.team` in the UI.

## gbrain integration (NEEDS SCOPE) — "connected to gbrain"
Two interpretations — pick one for v1:
- **B1 (lighter):** gbrain *reads* `agentbox.team`/`contacts` (direct Postgres query or a sync
  job) so people/orgs become brain context / Brain Graph nodes.
- **B2 (heavier):** repoint gbrain's store from PGLite to this Postgres. Large, separate effort;
  out of scope for this PRD's v1.
*Recommendation:* B1, and only after the tabs ship.

## Phases
1. **Schema + storage** — ✅ DONE (2026-06-04). Migration `047` → `mailbox.departments`,
   `mailbox.team_members`, `mailbox.crm_contacts` (+ dedup index). Tables in `mailbox` schema
   (matches the runner), not `agentbox`. Applied via psql + recorded in `mailbox.migrations`.
2. **Backend CRUD** — ✅ DONE. `dashboard/lib/crm/{queries,coerce}.ts` (raw pg) +
   `dashboard/app/api/crm/{departments,team,contacts}[/[id]]/route.ts`. Endpoints live under
   the dashboard **`/dashboard` basePath** → `127.0.0.1:3001/dashboard/api/crm/...`. Full
   CRUD verified (GET/POST/PATCH/DELETE; JSONB phones/emails/socials round-trip). Committed on
   mailbox2 `feat/agentbox-unified` `c995206`.
3. **Frontend tabs** — TODO. Team + Contacts React pages in hermes-agent/web + primary nav
   entries; call the proxied `/dashboard/api/crm/...` (same-origin via the existing reverse proxy).
4. **Job assignment** — TODO. Department + Employee on the cron create/edit modal + job card
   (extend `cron/jobs.py` create/update to store the fields).
5. **gbrain read access (B1)** — TODO. gbrain reads `mailbox.crm_contacts`/`team_members`.
6. **Google People import** — TODO (user chose "CRM + import from Google"): import the existing
   read-only People rows into `crm_contacts` (source='google', external_id=resourceName, deduped).

## Out of scope (v1)
- Auto-importing agents from hermes profiles (manual entry first).
- Permissions/multi-user; contact dedup/merge; calendar/CRM sync; repointing gbrain off PGLite.

## Open questions
1. Architecture: **Option A or B?**
2. gbrain scope: **B1 now, or defer all gbrain work?**
3. Nav placement: Team + Contacts as **primary nav tabs**, or under **Settings**?

## Decisions locked (2026-06-04)
- **Architecture: Option A** — CRUD + tables in the Node mailbox-dashboard (already on Postgres);
  hermes dashboard renders the tabs via the existing `/dashboard/*` proxy.
- **gbrain: B1 included** — gbrain reads `agentbox.team` / `agentbox.contacts` in this build.
- **Nav: primary nav tabs** — Team + Contacts added to the primary sidebar.
- Cron Department/Employee: extend `cron/jobs.py` create/update + the CronPage modal.

## Build reality (verified 2026-06-04) — read before coding
- **Source of truth = mailbox2**, repo `~/mailbox` on branch **`feat/agentbox-unified`**
  (remote `github.com/UMB-Advisors/mailbox.git`). The workstation `/home/bob/mailbox/mailbox`
  is on stale `master` (no `contacts`/channel-agnostic-inbox). **Do NOT build from the
  workstation** — it would regress the appliance. Work on mailbox2's checkout (or pull
  `feat/agentbox-unified` to the workstation first).
- **Naming collision:** an `app/api/contacts` route already exists, but it's **MBOX-398
  Google People API (read-only)** for the inbox right-rail — NOT a CRM. The new managed
  Contacts tab needs a distinct store/namespace (e.g. `agentbox.contacts` + `/api/crm/contacts`)
  so it doesn't clobber the People panel. (Open: should the CRM tab also import People contacts?)
- **Migrations**: numbered SQL in `dashboard/migrations/` (latest `046`) + `npm run migrate`
  (tsx runner). New tables → migration `047-…`.
- **Deploy**: rsync code to Jetson → `docker compose build mailbox-dashboard` (~3–6 min on the
  Orin) → `up -d` → `npm run migrate`. Slow image rebuild; batch changes.
- **gbrain (B1)**: gbrain is bun/TS on PGLite; for read access it connects to this Postgres
  (loopback publish + creds from `~/mailbox/.env`).
- DB: `postgresql://mailbox:<pw>@postgres:5432/mailbox` (creds in `~/mailbox/.env`).
