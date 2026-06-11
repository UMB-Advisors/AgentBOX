# CRM + Unified Inbox — Schema Reconciliation

**Version:** 0.1.0
**Date:** 2026-06-11
**Status:** Draft — for operator sign-off before build resumes
**Author:** design spike (Plan 015)
**Sources reconciled:**
- `docs/team-contacts-prd.v0.1.0.md` (2026-06-04, draft, awaiting architecture sign-off)
- `docs/unified-inbox-prd.v0.1.0.md` (internal version 0.2.0 despite filename, 2026-06-01, architecture locked)
- Migrations `047`, `048`, `049` in `mailbox/dashboard/migrations/`

---

## TL;DR

The two PRDs and the three shipped migrations are **substantially aligned** — not conflicting.
The team-contacts PRD used `agentbox.*` in its early data-model section but the Phases section
(and the migrations) already locked on `mailbox.*`; that namespace entry is stale text, not a
fork. The `businesses` table (migration 048) is an organic extension the PRDs don't mention but
don't contradict. The unified-inbox PRD introduces four new entities (`accounts`, `inbox_messages`,
`drafts`, `credentials`) that are fully orthogonal to the CRM tables; the only shared dependency is
the `mailbox` schema namespace and the same Postgres instance. The recommended single model below
keeps all CRM tables as shipped and adds the inbox tables alongside them.

---

## 1. Entity Map

Every entity named in either PRD, mapped against the shipped migrations.

| PRD Entity (name as written) | Source PRD | Shipped Table | Migration | Status | Notes |
|---|---|---|---|---|---|
| `agentbox.departments` | team-contacts data-model section | `mailbox.departments` | 047:L7-12 | **Shipped** (namespace mismatch in PRD text — see §2, Conflict A) |
| `agentbox.team` | team-contacts data-model section | `mailbox.team_members` | 047:L14-24 | **Shipped** (name mismatch — see §2, Conflict B) |
| `agentbox.contacts` | team-contacts data-model section | `mailbox.crm_contacts` | 047:L26-40 | **Shipped** (name mismatch — see §2, Conflict B) |
| *(unnamed)* businesses / companies | unified-inbox PRD (implicit: operator entity list) | `mailbox.businesses` | 048:L12-18 | **Shipped** — not in either PRD; organic addition |
| `accounts` (channel-agnostic) | unified-inbox PRD §Data model | — | — | **Not shipped** |
| `inbox_messages` (generalized) | unified-inbox PRD §Data model | Partial — existing email table exists, not yet generalized | — | **Partially shipped** (email-only; channel columns not added) |
| `drafts` (generalized) | unified-inbox PRD §Data model | Partial — existing drafts table exists, not yet generalized | — | **Partially shipped** (email-only; `channel`/`account_id` not added) |
| `credentials` (unified) | unified-inbox PRD §Data model | — | — | **Not shipped** |
| `mailbox.job_outcomes` | *(not in either PRD; MBOX-462)* | `mailbox.job_outcomes` | 049:L28-68 | **Shipped** — references `businesses.id` (048) and `departments.id` (047); PRDs should note this downstream consumer |

### Shipped schema summary (citations)

**`mailbox.departments`** — `047-create-crm-tables-v1-2026-06-04.sql` lines 7–12:
`id SERIAL PK, name TEXT UNIQUE, created_at, updated_at`

**`mailbox.team_members`** — `047-create-crm-tables-v1-2026-06-04.sql` lines 14–24:
`id SERIAL PK, name TEXT, kind TEXT ('human'|'agent'), title TEXT, department_id → departments, email TEXT, status TEXT ('active'|'inactive'), notes TEXT, timestamps`

**`mailbox.crm_contacts`** — `047-create-crm-tables-v1-2026-06-04.sql` lines 26–40:
`id SERIAL PK, name TEXT, company TEXT, phones JSONB, emails JSONB, socials JSONB, tags JSONB, notes TEXT, source TEXT ('manual'|'google'), external_id TEXT, timestamps`
Plus dedup index on `(source, external_id) WHERE external_id IS NOT NULL` — `047-create-crm-tables-v1-2026-06-04.sql` line 43–44.

**`mailbox.businesses`** — `048-crm-businesses-v1-2026-06-05.sql` lines 12–18:
`id SERIAL PK, name TEXT UNIQUE, description TEXT, timestamps`
Plus `ALTER TABLE mailbox.departments ADD COLUMN business_id INTEGER REFERENCES mailbox.businesses(id) ON DELETE SET NULL` — `048-crm-businesses-v1-2026-06-05.sql` lines 20–22.

**`mailbox.job_outcomes`** — `049-create-job-outcomes-v1-2026-06-07.sql` lines 28–68:
`id BIGSERIAL PK, source TEXT, external_job_id TEXT, job_name TEXT, profile TEXT, business_id → businesses, department_id → departments, outcome_type TEXT, status TEXT CHECK('success'|'partial'|'failed'|'skipped'), title TEXT, summary TEXT, artifact_ref JSONB, occurred_at TIMESTAMPTZ, created_at TIMESTAMPTZ`
Plus two indexes for brief rollup by `(business_id, occurred_at)` and `(department_id, occurred_at)`.

---

## 2. Conflicts and Decisions

### Conflict A — Schema namespace: `agentbox.*` vs `mailbox.*`

**What the team-contacts PRD says:** The "Data model" section header reads `Postgres, schema agentbox` and lists `agentbox.departments`, `agentbox.team`, `agentbox.contacts`.

**What shipped:** All tables are in `mailbox.*` — `mailbox.departments`, `mailbox.team_members`, `mailbox.crm_contacts`. This is confirmed by the PRD's own Phases section (Phase 1: "Tables in `mailbox` schema (matches the runner), not `agentbox`") and by `047-create-crm-tables-v1-2026-06-04.sql` lines 7, 14, 26.

**Decision: `mailbox.*` wins.** The Phases section and the migrations are the ground truth. The data-model prose section predates the final architecture decision (Option A — CRUD in mailbox-dashboard) and was never updated. Treat it as stale.

**Action:** PRD addendum recommended — add a note to the `docs/team-contacts-prd.v0.1.0.md` data model section stating the namespace was resolved to `mailbox.*` in Phase 1. Do not rewrite the PRD (operator convention: addendums, not rewrites).

---

### Conflict B — Table naming: PRD names vs shipped names

| PRD name | Shipped name | Migration |
|---|---|---|
| `agentbox.team` | `mailbox.team_members` | `047-create-crm-tables-v1-2026-06-04.sql` line 14 |
| `agentbox.contacts` | `mailbox.crm_contacts` | `047-create-crm-tables-v1-2026-06-04.sql` line 26 |

**Decision: shipped names win.** `team_members` is more precise than `team` (avoids collision with a potential `team` settings concept), and `crm_contacts` is intentional (the Phases section and migration comment both call out the need to distinguish from the MBOX-398 Google People endpoint at `/api/contacts`). The PRD prose predates the rename.

**Action:** Same addendum as Conflict A can cover this.

---

### Conflict C — `businesses` table not in either PRD

**What happened:** `048-crm-businesses-v1-2026-06-05.sql` (operator request 2026-06-05) created `mailbox.businesses` and added `business_id` to `departments`. Neither PRD mentions this table. Migration 049 then references it (`business_id → businesses`).

**Decision: accept as shipped; surface as a first-class entity.** The businesses table models exactly what both PRDs imply is needed (company-level attribution for job outcomes, department scoping). It is additive — nothing in either PRD contradicts it. The team-contacts PRD's Contacts entity (`company TEXT` field) is a soft reference (free-text), not a FK, so no schema conflict exists. The job-outcomes brief explicitly relies on `businesses.id` (`049-create-job-outcomes-v1-2026-06-07.sql` line 43).

**Action:** Both PRDs should acknowledge `mailbox.businesses` in an addendum. The recommended data model (§3) includes it.

---

### Conflict D — `contacts.company` (free-text) vs `businesses` (FK table)

**What the PRD says:** `agentbox.contacts` has `company TEXT` — a free-text field.

**What shipped:** `mailbox.crm_contacts.company` is `TEXT NOT NULL DEFAULT ''` (`047-create-crm-tables-v1-2026-06-04.sql` line 30). No `business_id` FK on `crm_contacts`.

**Decision: leave as-is for v1.** Adding a `business_id` FK to `crm_contacts` is a Phase 2 enhancement (bi-directional "contacts at this business" view), not needed to unblock either PRD. The free-text `company` column is sufficient for display and search. A future migration can add the FK and a data-migration step to backfill.

---

### Conflict E — Unified inbox `inbox_messages`/`drafts` generalization: not yet shipped

**What the PRD says:** Phase 0 of the unified-inbox PRD generalizes `inbox_messages` (add `channel`, `account_id`, `external_id`, etc.) and `drafts` (add `channel`, `account_id`) and creates new `accounts` and `credentials` tables. These migrations are listed as the first deliverable.

**What shipped:** The existing email-pipeline tables exist but the Phase 0 generalization migrations (add columns + new tables) have not been filed. Confirmed: migrations 047–049 are CRM/outcomes only; no `accounts` or `credentials` table exists; no `channel` column on inbox tables.

**Decision: no conflict — unstarted work.** This is not a contradiction with the CRM schema; it is simply the next migration set to write. The unified-inbox PRD Phase 0 migrations are independent of 047–049 and can be filed as 051–053 (050 is taken by the thread-id index migration from plans/002, on branch fix/queue-thread-history-batch; see §3).

---

### Non-Conflict: gbrain scope in team-contacts PRD

The team-contacts PRD "Decisions locked" section says "**gbrain: B1 included** — gbrain reads `agentbox.team`/`contacts` in this build." The Phases section records this as Phase 5 (TODO). The gbrain vendored copy (`gbrain-master/gbrain-master/`) contains **zero Python files** — the vendored tree is a checkout stub. No schema references exist to enumerate. The B1 contract is: gbrain connects to the appliance Postgres (`postgresql://mailbox:…@postgres:5432/mailbox`) and queries `mailbox.crm_contacts` and `mailbox.team_members` as read-only context. This is a forward declaration, not a conflict.

---

## 3. Recommended Single Data Model

All tables in `mailbox` schema. No `agentbox` schema needed.

```
mailbox
├── CRM layer (shipped, 047-048)
│   ├── businesses          id, name, description, timestamps
│   ├── departments         id, name, business_id→businesses, timestamps
│   ├── team_members        id, name, kind, title, department_id→departments,
│   │                       email, status, notes, timestamps
│   └── crm_contacts        id, name, company(text), phones/emails/socials/tags (jsonb),
│                           notes, source, external_id, timestamps
│                           [future v2: +business_id→businesses]
│
├── Job outcomes layer (shipped, 049)
│   └── job_outcomes        id, source, external_job_id, job_name, profile,
│                           business_id→businesses, department_id→departments,
│                           outcome_type, status, title, summary, artifact_ref,
│                           occurred_at, created_at
│
└── Unified inbox layer (not yet shipped — Phase 0 next)
    ├── accounts            id, channel, display_name, identity, credential_ref,
    │                       enabled, created_at
    ├── inbox_messages      (existing + add: channel, account_id→accounts,
    │                       external_id, sender, recipient, thread_ref,
    │                       received_at, classification, metadata jsonb)
    ├── drafts              (existing + add: channel, account_id→accounts)
    └── credentials         id, kind, provider, account_ref, secret_enc,
                            scopes, status, last_verified_at
```

No table conflicts. No namespace conflicts. The CRM layer and inbox layer share `mailbox` schema and the same Postgres instance but have no FK dependencies between them (job_outcomes is the only cross-layer FK, referencing CRM's `businesses` and `departments`).

---

## 4. Phase-1 Cut

"Smallest buildable slice that unblocks both PRDs and leaves the system in a shippable state."

Phase 1 as defined here = complete the **remaining team-contacts PRD work** + file the **unified-inbox Phase 0 migrations** as a foundation. These can be parallelized.

### 4A. Complete team-contacts PRD (remaining TODO phases)

| Item | Migration / Route | Based on | Effort | Notes |
|---|---|---|---|---|
| Frontend: Team tab (React page) | — | PRD Phase 3; calls `/dashboard/api/crm/team` + `/api/crm/departments` | M | Hermes-agent/web, proxied via existing reverse proxy |
| Frontend: Contacts tab (React page) | — | PRD Phase 3; calls `/dashboard/api/crm/contacts` | M | Include search/filter by name, company, tags |
| Frontend: Businesses tab or Settings section | — | Migration 048 ships but no UI exists | S | Can live under Settings; simple CRUD list |
| Job assignment on cron modal | — | PRD Phase 4; extend `cron/jobs.py` create/update dict with `department_id` + `employee_id` | M | Extend `CronPage` modal; resolve name from `mailbox.team_members` in UI |
| Job assignment on job card display | — | PRD Phase 4 | S | Read-only display of department + employee name |
| Google People import into crm_contacts | — | PRD Phase 6 | M | `source='google'`, `external_id=resourceName`; dedup index already exists |
| gbrain B1 read access | — | PRD Phase 5 | S | Config: publish Postgres loopback + env creds; gbrain query on `crm_contacts`/`team_members` |

Tests to extend: `mailbox/dashboard/test/routes/job-outcomes.test.ts` and `mailbox/dashboard/test/lib/job-outcomes.test.ts` are the pattern for raw-pg route + lib tests. New CRM tab tests follow the same structure under `test/routes/crm/` and `test/lib/crm/`.

**Exclusions (v1):** bulk import/export, `business_id` FK on `crm_contacts`, contact-merge, Hermes native pages (not proxied), contact timeline/activity log.

### 4B. Unified Inbox Phase 0 — channel-agnostic schema foundation

| Item | Migration name (suggested) | Effort | Notes |
|---|---|---|---|
| `accounts` table | `051-inbox-accounts-v1-YYYY-MM-DD.sql` | S | New table, no dependencies |
| `credentials` table | `052-inbox-credentials-v1-YYYY-MM-DD.sql` | S | New table; `account_ref` is soft-text ref to `accounts.id` |
| Generalize `inbox_messages` | `053-inbox-messages-channel-v1-YYYY-MM-DD.sql` | M | ALTER TABLE adds `channel`, `account_id`, `external_id`, `sender`, `recipient`, `thread_ref`, `received_at`, `classification`, `metadata jsonb`; backfill existing rows with `channel='email'` |
| Generalize `drafts` | `053` or separate `054` | S | ALTER TABLE adds `channel`, `account_id` |

**Exit criterion for 4B Phase 0:** existing email pipeline continues to work on the new schema (backfill + nullable columns). No UI changes required at this stage.

**Exclusions (Phase 0):** n8n workflow changes, forward-to-n8n bridge, social channel adapters, native dashboard inbox pages (Phase 1 of unified-inbox PRD), send path (Phase 4).

---

## 5. External Contracts (gbrain)

**Current state of vendored gbrain:** `gbrain-master/gbrain-master/` contains zero Python files in this worktree — the vendored copy is a directory stub. No schema references to enumerate from source.

**Contract implied by the team-contacts PRD (Phase 5 — B1):**
- gbrain connects to `postgresql://mailbox:<pw>@postgres:5432/mailbox` (loopback-published from Docker Compose; creds from `~/mailbox/.env`).
- gbrain queries `mailbox.crm_contacts` (read-only) — columns it needs: `id`, `name`, `company`, `phones`, `emails`, `socials`, `tags`, `notes`.
- gbrain queries `mailbox.team_members` (read-only) — columns it needs: `id`, `name`, `kind`, `title`, `department_id`, `email`, `status`.
- gbrain is bun/TS on PGLite for its own store; the above is an additional read-only Postgres connection, not a store migration (B2 is explicitly out of scope).

**gbrain as a consumer of job_outcomes (migration 049):** migration 049 notes `source = 'gbrain_minion'` as a known emitter value (`049-create-job-outcomes-v1-2026-06-07.sql` line 34). This means gbrain minions are expected to POST to `/api/internal/job-outcomes` when they complete tasks. This is a write contract, not a read contract. No schema changes required on gbrain's side — it just needs the endpoint URL and the payload schema (defined in `mailbox/dashboard/lib/schemas/job-outcomes.ts`).

---

## 6. Open Questions (Operator Decisions Required)

### OQ-1: Architecture sign-off for team-contacts PRD
The team-contacts PRD marks its architecture decision (Option A vs B) as "NEEDS SIGN-OFF." Per the evidence: Option A is already implemented (migration 047/048 shipped, CRUD routes shipped per `c995206` on `feat/agentbox-unified`). **Recommend formally closing: Option A is locked.** Add an addendum to `docs/team-contacts-prd.v0.1.0.md` recording the sign-off date.

### OQ-2: Filename/version mismatch on unified-inbox PRD
`docs/unified-inbox-prd.v0.1.0.md` contains `**Version:** 0.2.0` in its header. The filename says `0.1.0`. **Recommend:** rename the file to `docs/unified-inbox-prd.v0.2.0.md` (no content change) so version tracking is consistent with the operator's semver file-naming convention. This is a rename, not a rewrite — safe.

### OQ-3: `businesses` entity — add to team-contacts PRD?
`mailbox.businesses` shipped without being specified in either PRD. It is the natural home for the operator's entity list (Heron Labs, STATE, etc.) and is already load-bearing via `job_outcomes.business_id`. **Recommend:** add an addendum to `docs/team-contacts-prd.v0.1.0.md` acknowledging `mailbox.businesses` as a first-class CRM entity and noting the Settings > Businesses UI is an outstanding TODO.

### OQ-4: gbrain scope for B1 — include now or defer?
The team-contacts PRD locked B1 as included. The implementation is Phase 5 (TODO). Given that Phases 1 and 2 of that PRD are shipped, B1 is the natural next gbrain-side task after the frontend tabs land. No decision conflict — just a sequencing question for the backlog.

### OQ-5: Linear epic structure for unified inbox
The unified-inbox PRD is v0.2.0 and has 5 phases. It does not yet have Linear issues filed for Phase 0 migrations. **Recommend:** file a MBOX epic + Phase 0 issue set before starting migration work on 051+.

### OQ-6: `crm_contacts.business_id` FK — Phase 2 or defer?
Free-text `company` column is sufficient for v1 (per §2 Decision D). Decision point: when to add the FK and data-migration. Recommend treating as a separate Phase 2 backlog item, not a blocker for either current PRD.

---

## Addendum Recommendations

Both PRDs should receive addendums (not rewrites) to:
1. Record the `agentbox.*` → `mailbox.*` namespace resolution and the table renames (`team` → `team_members`, `contacts` → `crm_contacts`).
2. Acknowledge `mailbox.businesses` as a first-class entity introduced in migration 048.
3. Note `mailbox.job_outcomes` (migration 049) as a downstream consumer of the CRM tables.
4. For the unified-inbox PRD: record that Phase 0 migrations are the next unblocked work, filing as 050–052.

These are editorial only — no schema or code changes implied.
