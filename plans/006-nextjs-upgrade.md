# Plan 006: Upgrade Next.js off 14.2.35 to clear the open HIGH advisories

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- mailbox/dashboard/package.json mailbox/dashboard/package-lock.json mailbox/dashboard/next.config.js`
> On any mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (framework major/minor bump; app-router behavior changes)
- **Depends on**: plans/001-root-ci-gate.md, plans/003-approve-send-integration-test.md (upgrade lands with a safety net)
- **Category**: migration/security
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

`npm audit --omit=dev` (run 2026-06-11 in `mailbox/dashboard`) reports
**2 high + 1 moderate** vulnerabilities, all rooted in `next@14.2.35`:
RSC cache poisoning (GHSA-vfv6-92ff-j949, GHSA-wfc6-r584-vfw7), SSRF via
WebSocket upgrades (GHSA-c4j6-fc7j-m34r), image-optimizer DoS
(GHSA-h64f-5h5j-jqjh), i18n middleware bypass (GHSA-36qx-fr4f-26g5), plus a
bundled-postcss XSS (GHSA-qx2v-qp2m-jg93). npm's suggested fix is
`next@16.2.9` (breaking). The dashboard fronts an email-sending appliance and
is internet-reachable when Tailscale Funnel is enabled, so these aren't
theoretical.

## Current state

- `mailbox/dashboard/package.json` — `"next": "14.2.35"`, scripts:
  `dev` (`next dev -p 3001`), `build` (`next build`), `typecheck`
  (`tsc --noEmit`), `test` (vitest), `lint` (biome). 14 prod deps. Lockfile:
  `package-lock.json` (npm, not pnpm — this app predates the global pnpm
  preference; **stay with npm** here).
- App router (`app/` directory) with API route handlers
  (`app/api/**/route.ts`), `dynamic = 'force-dynamic'` exports on routes,
  `next.config.js` present, `instrumentation.ts` present.
- Builds run inside Docker too: `mailbox/docker-compose.yml`
  `mailbox-dashboard` service builds `./dashboard` with
  `GITHUB_PACKAGES_TOKEN` build-arg (`dashboard/.npmrc` needs it for
  `@umb-advisors/*`).
- Node 20 (CI workflow and compose both use node 20 images).

## Commands you will need

(Working directory: `mailbox/dashboard`; `GITHUB_PACKAGES_TOKEN` env var
required for `npm install`/`npm ci`.)

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Audit | `npm audit --omit=dev` | after upgrade: 0 high/critical |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Tests | `TEST_POSTGRES_URL=... npm test` | all pass |
| Build | `npm run build` | exit 0, no fatal warnings |

## Scope

**In scope**:
- `mailbox/dashboard/package.json`, `package-lock.json`
- `mailbox/dashboard/next.config.js`, `tsconfig.json` — only changes the
  upgrade itself forces
- Mechanical code changes the codemods/compiler force (e.g., async
  `params`/`searchParams` in Next 15 route handlers and pages)

**Out of scope**:
- Feature work, refactors, dependency bumps unrelated to next/react/postcss
- `mailbox/docker-compose.yml` (unless the node image must move past 20 —
  if so, STOP and report instead)
- The Python backend; the Hermes pin

## Git workflow

- Branch: `chore/next-upgrade`
- Commits: one for the dependency bump, one per mechanical codemod sweep
  (style: `chore(dashboard): upgrade next 14.2.35 → <version>`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pick the target — smallest version clearing the audit

Try Next 15 first (smaller blast radius than 16):
`npm install next@15 && npm audit --omit=dev`. If high-severity advisories
remain against the installed 15.x, escalate to `next@16` (npm audit's
suggested fix). React version: follow Next's peer-dependency requirement —
check `npm ls react` after install and bump react/react-dom together if the
peer range demands it.

**Verify**: `npm audit --omit=dev` → 0 high/critical findings.

### Step 2: Run the official codemods, then fix the residue

`npx @next/codemod@latest upgrade` (it inspects the app and applies the
relevant transforms, notably async request APIs: in Next 15, `params`,
`searchParams`, `cookies()`, `headers()` become async). Then:

- `npm run typecheck` and fix every error mechanically. Expect the bulk in
  `app/api/**/route.ts` handlers that destructure `{ params }` — the
  repo-wide pattern is `parseParams(params, idParamSchema)` (see
  `app/api/drafts/[id]/approve/route.ts`); the fix is awaiting `params`
  before passing it through, keeping `parseParams` itself untouched if
  possible (or adjusting its signature in `lib/middleware/validate.ts` once,
  consistently, if every caller changes anyway — prefer the smallest diff).

**Verify**: `npm run typecheck` → exit 0; `npm run lint` → exit 0.

### Step 3: Tests + build

**Verify**: `TEST_POSTGRES_URL=... npm test` → all pass (including the
plan-003 approve suite if it has landed). Then `npm run build` → exit 0.
Inspect the build output for route-level warnings about dynamic rendering;
routes that export `dynamic = 'force-dynamic'` should still list as dynamic.

### Step 4: Docker build check

From `mailbox/`: `docker build --build-arg GITHUB_PACKAGES_TOKEN="$GITHUB_PACKAGES_TOKEN" -t mailbox-dashboard:upgrade-test ./dashboard`
→ exit 0. (Skip if Docker is unavailable in your environment; flag it in the
report as an unverified step.)

## Test plan

No new tests; the gate is the existing suite + typecheck + build + audit.
If plan 003 hasn't landed yet, note in your report that the money path was
verified only by the existing finalize/auto-send suites.

## Done criteria

- [ ] `npm audit --omit=dev` reports 0 high/critical
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all exit 0
- [ ] `git diff --stat` touches only package files + mechanically-forced code changes
- [ ] Docker image builds (or explicitly reported as not testable)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Next 15/16 requires Node > 20 — the appliance images pin node:20; report
  rather than bumping the runtime unilaterally.
- The codemod produces changes in more than ~40 files or rewrites
  non-mechanical logic — stop and report the blast radius first.
- `npm test` failures that aren't typed-API mechanical (e.g., behavior change
  in route caching breaking a webhook contract).
- `@umb-advisors/*` package install fails (token/registry issue) — report;
  don't switch registries.

## Maintenance notes

- After this lands, add `npm audit --omit=dev --audit-level=high` as a CI step
  (extend plan 001's workflow) so the lag never silently rebuilds.
- Reviewer: diff `next.config.js` carefully — deprecated options are where
  silent behavior changes hide.
- Deferred: react 19 feature adoption; Turbopack; any app-router cache
  semantics tuning.
