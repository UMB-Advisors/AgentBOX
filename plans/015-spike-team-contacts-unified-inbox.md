# Plan 015: Design spike — reconcile Team/Contacts + Unified Inbox PRDs with the shipped CRM schema

> **Executor instructions**: This is a DESIGN SPIKE, not a build plan. The
> deliverable is a reconciliation document plus a phase-1 schema proposal —
> not code, not migrations. Follow the steps, honor STOP conditions, update
> `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- docs/unified-inbox-prd.v0.1.0.md docs/team-contacts-prd.v0.1.0.md mailbox/dashboard/migrations/`
> New migrations or PRD bumps mean the ground moved — re-inventory.

## Status

- **Priority**: P2 (product)
- **Effort**: M (spike); build is L, phased
- **Risk**: LOW (documents only)
- **Depends on**: none (informs future build plans)
- **Category**: direction
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

Two locked-ish PRDs describe the next product surface: **Team, Contacts & Job
Assignment** (docs/team-contacts-prd.v0.1.0.md, "Draft — awaiting architecture
sign-off before build") and **Unified Inbox** (docs/unified-inbox-prd.v0.1.0.md,
v0.2.0, "architecture locked via decisions below; phasing for review").
Meanwhile the codebase has *already grown* CRM tables (migrations
047-create-crm-tables, 048-crm-businesses, 049-job-outcomes referencing
`businesses.id` and `department_id`). The PRDs were written around the same
weeks those migrations landed; nobody has verified they agree. Building either
PRD without reconciliation risks a second, divergent contacts/team schema on
the same box. The spike produces the reconciled data model and a phase-1 cut.

## Current state (verified at planned-at SHA)

- `docs/team-contacts-prd.v0.1.0.md` — 2026-06-04, draft, awaiting sign-off.
  TL;DR: "Add two CRM-style tabs to the AgentBOX dashboard — Team (humans +
  agents...)" (read the full doc in Step 1).
- `docs/unified-inbox-prd.v0.1.0.md` — v0.2.0 inside the file (filename says
  0.1.0 — note the mismatch), 2026-06-01. Targets: "MailBOX (Postgres schema +
  n8n) · AgentBOX/Hermes dashboard (hermes-agent/web) · mailbox-dashboard
  (absorbed)".
- Shipped schema (read these fully in Step 1):
  - `mailbox/dashboard/migrations/047-create-crm-tables-v1-2026-06-04.sql`
  - `mailbox/dashboard/migrations/048-crm-businesses-v1-2026-06-05.sql`
  - `mailbox/dashboard/migrations/049-create-job-outcomes-v1-2026-06-07.sql`
    — header documents: one row per agent-job outcome, `profile` (company)
    resolved → `businesses.id`, `department_id` soft-references the CRM,
    feeds the Daily Brief rollup (MBOX-462).
- Dashboard features already touching this domain: Agent Jobs
  sort-by-department (commit d06a8bc), per-job model selector (fc288ec),
  job-outcomes brief (bdf220d), `test/routes/job-outcomes.test.ts` exists.
- gBrain (vendored, `gbrain-master/`) is named by the unified-inbox PRD as a
  reader of the new tables — treat its schema expectations as an external
  contract to enumerate, not modify.

## Commands you will need

| Purpose | Command |
|---------|---------|
| Read shipped CRM schema | `cat mailbox/dashboard/migrations/04{7,8,9}-*.sql` |
| Find CRM consumers | `grep -rln "businesses\|department" mailbox/dashboard/lib mailbox/dashboard/app --include="*.ts" \| head -20` |
| PRD entity lists | read both PRDs end to end |

## Scope

**In scope (deliverables)**:
- `docs/team-contacts-unified-inbox-reconciliation.v0.1.0.md` (create):
  entity-by-entity mapping (PRD entity ↔ shipped table ↔ gap), conflicts
  list, recommended single data model, phase-1 cut with effort estimates,
  open questions.

**Out of scope**:
- Migrations, routes, UI code, n8n workflows
- Editing either PRD (the operator's convention is addendums, not rewrites —
  recommend an addendum in the doc if the PRDs need correcting)
- gbrain code

## Git workflow

- Branch: `docs/crm-prd-reconciliation`
- One commit: `docs(crm): reconcile team-contacts + unified-inbox PRDs with shipped 047-049 schema`

## Steps

### Step 1: Build the entity map

Read both PRDs and the three migrations. Produce a table: every entity the
PRDs define (`agentbox.departments`, `agentbox.team`, `agentbox.contacts`,
anything else) vs what migrations 047/048 already created (names, schema
namespace — note the PRDs say `agentbox.*` while shipped tables appear to live
in the `mailbox` schema; confirm from the SQL). For each: exists / partially
exists / missing / conflicts.

### Step 2: Identify the conflicts and decide

For each conflict (likely candidates: schema namespace, `businesses` vs the
PRD's company/team modeling, department as table vs column, where contacts
live relative to the email pipeline's sender data), write the decision with a
one-paragraph rationale. Bias per the audit: the **shipped** schema wins
unless the PRD documents a reason it can't (re-platforming a live table on
customer boxes is the expensive path).

### Step 3: Phase-1 cut

Define the smallest buildable slice that unblocks both PRDs (probably: the
reconciled contacts/team tables + read/create API + one dashboard tab),
with: migration list (names only), routes, which existing tests to extend
(`test/routes/job-outcomes.test.ts` is the pattern), effort (S/M/L per item),
and explicit exclusions (bulk ops, gbrain integration, Hermes-native pages).

### Step 4: External contracts + open questions

Enumerate what gbrain expects to read (search `gbrain-master` for table/SQL
references if greppable — `grep -rn "agentbox\.\|mailbox\." gbrain-master/gbrain-master --include="*.py" -l | head`),
and list operator decisions (sign-off items from the team-contacts PRD,
filename-version mismatch on the unified-inbox PRD, Linear epic structure).

## Done criteria

- [ ] Reconciliation doc exists with: TL;DR, entity map table, decided
      conflicts with rationale, phase-1 cut, gbrain contract notes, open
      questions
- [ ] Every claim about shipped schema cites a migration file:line
- [ ] No source code modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Migrations 047–049 don't contain what the headers promise (mis-read of
  shipped state would poison every downstream decision — re-verify first).
- A newer PRD version exists elsewhere (`grep -rn "team-contacts\|unified-inbox" docs/ --include="*.md" -l`)
  — reconcile against the newest.

## Maintenance notes

- The decided data model should become an ADR (`docs/decisions/`) when the
  operator signs off — note that in the doc.
- Whoever builds phase 1 should turn this spike's cut into a proper build
  plan (new plans/0NN) with the migration SQL specified.
