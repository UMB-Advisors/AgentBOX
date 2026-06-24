# Plan 008: Verify and harden the unauthenticated onboarding API routes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- mailbox/dashboard/app/api/internal/onboarding/ mailbox/caddy/ config/Caddyfile.funnel.template`
> On any mismatch with the excerpts below, STOP.

## Status

- **Priority**: P2
- **Effort**: S (investigation) + S (defensive check)
- **Risk**: LOW — additive guard behind existing validation
- **Category**: security
- **Depends on**: none
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

The onboarding wizard's state-changing API routes are deliberately not
session-gated — the code banks on Caddy `basic_auth` covering every path at
the edge. That assumption is per-box configuration, not code, and the routes
can flip the appliance's onboarding stage and (via the connect routes) attach
mailboxes. If any deployment exposes the dashboard without the Caddy gate
(e.g., a direct tunnel to the Next.js port, or a Funnel config that bypasses
Caddy), these routes are open to the internet. This plan (a) determines the
actual exposure, (b) adds a cheap defensive gate so the routes fail closed.

## Current state

- `mailbox/dashboard/app/api/internal/onboarding/advance/route.ts` — comment
  (verbatim):
  ```
  // Internal-only: not Caddy basic_auth gated. The wizard pages call this from
  // the customer's browser, so it IS publicly reachable through the dashboard
  // routing — but the operation is bounded (one DB row UPDATE on a single
  // non-secret enum column) and zod-validated (STAQPRO-138). HMAC gating is a
  // planned hardening once the broader internal-route auth model lands.
  ```
  Body schema requires `{ from, to, customer_key }`; transitions restricted to
  adjacent pairs via `isAllowedTransition` (`lib/onboarding/wizard-stages.ts`,
  `ALLOWED_TRANSITIONS` at line 114). Note the comment understates the family:
  sibling routes `imap-connect` and `graph-connect` accept credentials.
- `config/Caddyfile.funnel.template` — the funnel-side Caddy config asserts
  (verbatim): "basic_auth gates all paths — the OAuth callback still works
  because the operator's authenticated browser carries the basic_auth
  through". So the *intended* topology is gated.
- Sibling routes (same directory): `imap-connect`, `graph-connect` — find the
  full set with `ls mailbox/dashboard/app/api/internal/onboarding/`.
- Repo validation convention: zod schemas in `lib/schemas/*`, parsed via
  `parseJson` from `lib/middleware/validate` (see the excerpt's imports).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Enumerate the route family | `ls mailbox/dashboard/app/api/internal/onboarding/` | list of route dirs |
| Find all caddy configs | `grep -rn "basic_auth" mailbox/caddy/ config/ mailbox/docker-compose.yml` | every gate location |
| Typecheck/lint/test | `cd mailbox/dashboard && npm run typecheck && npm run lint && npm test` | exit 0 / pass |

## Scope

**In scope**:
- Investigation across `mailbox/caddy/`, `config/`, compose files (read-only)
- `mailbox/dashboard/app/api/internal/onboarding/*/route.ts` — add the guard
- One new tiny helper, e.g. `mailbox/dashboard/lib/middleware/onboarding-auth.ts`
- `mailbox/dashboard/.env.example` — document the new env var
- Tests under `mailbox/dashboard/test/routes/`

**Out of scope**:
- The "broader internal-route auth model" the comment promises — do not design
  it here; this is a stopgap.
- Caddy config changes on live boxes (operator action).
- Other `/api/internal/*` routes (draft-prompt etc.) — n8n calls those
  container-to-container; gating them breaks the pipeline. Onboarding routes
  only.

## Git workflow

- Branch: `fix/onboarding-route-auth`
- Commits: `docs(security): record onboarding-route exposure analysis` then
  `fix(dashboard): shared-secret gate on onboarding mutation routes`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Map the real exposure (investigation)

Trace, in the repo only (no live-box probing):
1. Every Caddy config (`mailbox/caddy/`, `config/Caddyfile.funnel.template`)
   — does each one apply `basic_auth` to all paths in front of the dashboard
   port?
2. The compose port bindings for `mailbox-dashboard` — is :3001 bound to
   loopback/container-only, or published on 0.0.0.0?
3. Any path where a browser reaches the dashboard WITHOUT passing Caddy
   (the Hermes `:9119` dashboard proxies an inbox view — check
   `bin/deploy-dashboard.sh`'s header comment "the /dashboard inbox proxy" and
   find that proxy in `hermes_cli/web_server.py`; determine whether it can
   reach the onboarding API paths).

Write the result as a short analysis block in the commit message (not a new
doc): per ingress, gated or not.

**Verify**: you can answer, with file:line citations, "can an unauthenticated
internet client reach POST /api/internal/onboarding/advance on a
correctly-configured box?"

### Step 2: Add the defensive gate

Regardless of Step 1's answer (defense in depth — config drifts), add a
shared-secret check to the onboarding **mutation** routes:

- Helper `requireOnboardingToken(req: NextRequest): NextResponse | null` —
  reads env `ONBOARDING_API_TOKEN`; if the env var is set, require header
  `x-onboarding-token` to match (constant-time compare via
  `crypto.timingSafeEqual` on equal-length buffers); mismatch → 401 JSON.
  **If the env var is unset, allow** (preserves current single-tenant
  behavior; boxes opt in at provision time).
- Call it first in each `POST` handler under `app/api/internal/onboarding/`.
- The wizard pages call these routes from the browser; they must send the
  header. Locate the client fetches (`grep -rn "internal/onboarding" mailbox/dashboard/app mailbox/dashboard/components`)
  and thread the token via a server-rendered prop — NOT via
  `NEXT_PUBLIC_*` env (that compiles the secret into the public JS bundle;
  acceptable only if Step 1 proved every ingress is already basic_auth-gated —
  if you end up needing `NEXT_PUBLIC_`, STOP and report the trade-off
  instead of deciding).
- Update `.env.example` with `ONBOARDING_API_TOKEN` + one-line comment.
- Update the route comment block to describe the new gate (replace the
  "HMAC gating is a planned hardening" sentence).

**Verify**: `npm run typecheck && npm run lint` → exit 0.

### Step 3: Tests

In `test/routes/` (model on `test/routes/system.test.ts` or the onboarding
tests if present — check `ls test/routes/`):
1. Env var set + wrong/missing header → 401, DB untouched.
2. Env var set + correct header → behaves as before (reuse an existing
   advance-route test case if one exists).
3. Env var unset → behaves as before (back-compat).

**Verify**: `TEST_POSTGRES_URL=... npm test -- onboarding` → pass.

## Done criteria

- [ ] Exposure analysis with file:line citations in the first commit message
- [ ] All onboarding mutation routes call the token guard first
- [ ] Token is never exposed via `NEXT_PUBLIC_*`
- [ ] 3 new test cases pass; typecheck/lint clean
- [ ] `.env.example` documents `ONBOARDING_API_TOKEN`
- [ ] `plans/README.md` status row updated

## STOP conditions

- Step 1 reveals an ingress where the wizard browser flow CANNOT carry a
  server-provided header (e.g., static-exported pages) — report the
  architecture mismatch.
- Threading the token to the client requires `NEXT_PUBLIC_*` (see Step 2).
- You find the onboarding routes are already gated by a session/middleware
  layer this audit missed — then only the stale comment needs fixing; report.

## Maintenance notes

- This is explicitly a stopgap until the "broader internal-route auth model"
  lands; whoever builds that should delete `onboarding-auth.ts` in favor of
  the real session check.
- Provisioning follow-up (deferred): `install/agentbox-install.sh` should
  generate `ONBOARDING_API_TOKEN` into the box's `.env` so the gate is on by
  default for new installs.
- Reviewer: confirm the timing-safe compare handles unequal-length inputs
  without throwing.
