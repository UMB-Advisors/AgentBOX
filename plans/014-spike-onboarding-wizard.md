# Plan 014: Design spike — finish the customer onboarding wizard (STAQPRO-152)

> **Executor instructions**: This is a DESIGN SPIKE, not a build plan. The
> deliverable is a design document plus a phased issue breakdown — not code.
> Follow the steps, honor STOP conditions, update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- mailbox/dashboard/app/onboarding/ mailbox/dashboard/lib/onboarding/`
> Material changes mean the wizard moved since planning — re-inventory before
> writing anything.

## Status

- **Priority**: P2 (product) — first-run experience of a packaged product
- **Effort**: M (spike); build estimated M–L afterwards
- **Risk**: LOW (spike produces documents only)
- **Depends on**: plans/008-onboarding-route-auth.md (auth model decision
  feeds this design)
- **Category**: direction
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

AgentBOX is being packaged as a sellable appliance (docs/product/, Persona
Packs), but the customer's first ten minutes — the onboarding wizard — is
six placeholder pages. The state machine underneath is real and tested
(stage transitions, 409 contracts), so the remaining work is well-scoped UI +
two integration seams (admin password → Caddy, Gmail OAuth → n8n credential
handoff). The build shouldn't start until those two seams are designed —
that's this spike.

## Current state (all verified at planned-at SHA)

- All six pages are stubs, each tagged `TODO(STAQPRO-152)`:
  - `app/onboarding/welcome/page.tsx:5` — "brand intro + appliance overview — replace placeholder"
  - `app/onboarding/password/page.tsx:5` — "wire to STAQPRO-131 admin password create + Caddy"
  - `app/onboarding/profile/page.tsx:5` — "collect operator first name, brand, signoff seed"
  - `app/onboarding/network-check/page.tsx:5` — "live Caddy/Cloudflare cert health probe + LAN"
  - `app/onboarding/email-connect/page.tsx:42` — "real Gmail OAuth flow + n8n credential handoff"
  - `app/onboarding/complete/page.tsx:6` — "show first-poll ETA + link to /dashboard/queue"
- The machine underneath is built: `lib/onboarding/wizard-stages.ts` defines
  `WIZARD_STEPS` (slugs welcome → password → profile → network-check →
  email-connect → complete, each with `title`, `intent` copy, `dbStage` ∈
  {pending_admin, pending_email, ingesting, live}, `allowsBack`), and
  `ALLOWED_TRANSITIONS` (adjacent pairs only). The `advance` route enforces
  this with 409s on skip/backward/stale-from
  (`app/api/internal/onboarding/advance/route.ts`).
- Sibling connect routes exist: `imap-connect`, `graph-connect` (see
  `ls app/api/internal/onboarding/`).
- A parallel Google OAuth implementation already lives in the **Hermes**
  custom backend (`hermes_cli/web_server.py` `/api/google/auth/*`,
  `hermes_cli/google_accounts.py`) — the appliance currently does Gmail
  consent there, not in the wizard. Two OAuth stacks for one box is the
  central design tension.
- The dashboard reaches customers via Caddy with basic_auth
  (`config/Caddyfile.funnel.template`), and the wizard must work before the
  admin password exists — a bootstrapping-order question.

## Commands you will need

| Purpose | Command |
|---------|---------|
| Inventory wizard code | `ls mailbox/dashboard/app/onboarding/ mailbox/dashboard/app/api/internal/onboarding/` |
| Find STAQPRO-131 context | `grep -rn "STAQPRO-131" mailbox/ --include="*.ts" --include="*.tsx" --include="*.md"` |
| Read the Hermes OAuth flow | `sed -n '1490,1600p' hermes-agent-main/hermes-agent-main/hermes_cli/web_server.py` |

## Scope

**In scope (deliverables)**:
- `docs/onboarding-wizard-design.v0.1.0.md` (create — versioned filename per
  repo convention; lead with a 3-5 line TL;DR per operator preference)
- A phased issue breakdown inside that doc (ready to file as Linear MBOX-*
  issues; do NOT file them — the operator files)

**Out of scope**:
- Any change to `app/onboarding/**`, routes, or the Python backend
- Filing Linear issues; modifying PRDs

## Git workflow

- Branch: `docs/onboarding-wizard-design`
- One commit: `docs(onboarding): design for completing the STAQPRO-152 wizard`

## Steps

### Step 1: Inventory and constraints

Read all six pages, the wizard-stages lib, the three internal routes, the
Hermes `/api/google/auth/*` flow, and the Caddy template. Write the
"current state" section of the doc: what exists, what each TODO actually
needs, with file:line citations.

### Step 2: Decide the two seams (the heart of the spike)

For each, present 2 options with a recommendation:

1. **Gmail OAuth home**: (a) wizard drives the existing Hermes backend flow
   (iframe/redirect to :9119 routes; credentials then handed to n8n), vs
   (b) implement OAuth in mailbox-dashboard (`lib/oauth/google.ts` already
   has token-exchange code — cite what's reusable) and write the n8n
   credential via its API. Evaluate against: single source of token truth,
   re-consent UX (MBOX-460 precedent), failure modes mid-wizard.
2. **Admin password → Caddy**: how the password page writes the bcrypt hash
   into the live Caddy config (the template shows
   `docker run --rm caddy:2 caddy hash-password`), who restarts Caddy, and
   how the wizard survives its own gate appearing mid-flow (the
   bootstrapping-order problem). Cover the pre-password exposure window and
   tie into plan 008's token gate.

### Step 3: Phase the build

Break into 3–5 phases, each independently shippable, each with exit criteria.
Suggested shape (validate, don't assume): P1 copy/branding + complete page
(no integrations); P2 profile persistence; P3 password→Caddy; P4 OAuth
connect; P5 network-check probes. Per phase: effort (S/M/L), files touched,
test approach (the route tests exist — extend them), and what can go wrong.

### Step 4: Open questions for the operator

End the doc with the decisions only the operator can make (e.g., brand assets
for the welcome page, whether IMAP/Graph connect are v1 or follow-on, whether
the wizard must work fully offline-LAN).

## Done criteria

- [ ] `docs/onboarding-wizard-design.v0.1.0.md` exists: TL;DR, current-state
      inventory with citations, both seam decisions with recommendation,
      phased breakdown, open questions
- [ ] No source code modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The wizard pages are no longer stubs (someone built it) — verify the TODOs
  still exist before writing a word.
- You cannot locate the Hermes OAuth flow or the Caddy password mechanism —
  the design would be speculation; report what's missing.

## Maintenance notes

- The chosen OAuth seam decision should be recorded as an ADR if it
  consolidates the two stacks (operator's spec-driven convention:
  `docs/decisions/`, numbered).
- When the build phases get filed, link them to STAQPRO-152 lineage so the
  TODO tags can reference real issues.
