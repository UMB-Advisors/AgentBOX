# Plan 001: Make CI actually run — move the workflow to the repo root and add a bash syntax job

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- mailbox/.github/ .github/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

This repo has a complete CI workflow (typecheck + biome lint + vitest with a
Postgres service) at `mailbox/.github/workflows/ci.yml` — but GitHub Actions
only executes workflows from `.github/workflows/` at the **repository root**.
The file is a leftover from when MailBOX was its own repository. Result: the
last 24 merged PRs in this monorepo ran **zero** automated checks. The
dashboard auto-sends real customer email; regressions there currently reach
production silently. This plan is the verification gate every other plan in
`plans/` relies on, which is why it is plan 001.

## Current state

- `.github/` does **not exist** at the repo root (verified 2026-06-11).
- `mailbox/.github/workflows/ci.yml` — the dead workflow. Key facts from it:
  - Triggers on `branches: [master]` — but **this monorepo's default branch is
    `main`**, so even at the root it would never fire as-is.
  - `defaults.run.working-directory: dashboard` — relative to the old repo
    root; in the monorepo the app lives at `mailbox/dashboard`.
  - `cache-dependency-path: dashboard/package-lock.json` — same problem.
  - Installs deps with a GitHub Packages token (comment in the file, verbatim):
    `dashboard/.npmrc points @umb-advisors:* at npm.pkg.github.com and reads
    the auth token from ${GITHUB_PACKAGES_TOKEN}` … `a classic PAT with
    read:packages scope stored as the repo secret GH_PACKAGES_TOKEN`.
  - Applies `test/fixtures/schema.sql` to a `postgres:17-alpine` service
    before running vitest (`TEST_POSTGRES_URL=postgresql://mailbox:mailbox@localhost:5432/mailbox`).
- `mailbox/.github/workflows/publish-images.yml` — also dead at this path;
  **out of scope** here (image publishing needs separate validation; see
  Maintenance notes).
- Project CLAUDE.md declares the bash "test" as:
  `bash -n install/agentbox-install.sh bin/deploy-dashboard.sh bin/lib/custom-backend-files.sh`
- Repo commit style (from `git log`): `type(scope): summary`, e.g.
  `feat(provisioning): make Tailscale SSH the default for every install`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Validate YAML | `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` | exit 0 |
| Bash syntax | `bash -n install/agentbox-install.sh bin/deploy-dashboard.sh bin/lib/custom-backend-files.sh` | exit 0, no output |
| Local dashboard test (optional sanity) | `cd mailbox/dashboard && npm run typecheck` | exit 0 (requires node_modules; skip if `npm ci` is not possible locally) |

## Scope

**In scope** (the only files you should modify/create):
- `.github/workflows/ci.yml` (create — adapted copy)
- `mailbox/.github/workflows/ci.yml` (delete after the root copy exists)

**Out of scope** (do NOT touch):
- `mailbox/.github/workflows/publish-images.yml` — leave in place; migrating
  it needs registry-secret validation that is not part of this plan.
- `mailbox/dashboard/**` — no app changes.
- Any provisioning or install script.

## Git workflow

- Branch: `chore/root-ci-gate`
- One commit: `chore(ci): move dashboard CI to repo root so it actually runs`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Copy the workflow to the root with path/branch fixes

Create `.github/workflows/ci.yml` from `mailbox/.github/workflows/ci.yml` with
exactly these changes (keep everything else, including the comments — they
document the GH_PACKAGES_TOKEN constraint):

1. `branches: [master]` → `branches: [main]` (both `push` and `pull_request`).
2. `defaults.run.working-directory: dashboard` → `mailbox/dashboard`.
3. `cache-dependency-path: dashboard/package-lock.json` → `mailbox/dashboard/package-lock.json`.
4. Add path filters so docs-only changes don't burn CI minutes:
   ```yaml
   on:
     push:
       branches: [main]
     pull_request:
       branches: [main]
   ```
   (Do NOT add `paths:` filters to the dashboard job in this plan — required
   status checks with path filters skip silently and that nuance is easy to
   get wrong. Run on everything.)

**Verify**: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` → exit 0, and
`grep -n "mailbox/dashboard" .github/workflows/ci.yml` → at least 2 matches (working-directory + cache-dependency-path).

### Step 2: Add a bash syntax job

Append a second job to the same workflow (it must NOT have the
`working-directory` default — give it its own `defaults` or none):

```yaml
  bash-syntax:
    name: bash -n (install/deploy scripts)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Syntax-check owned shell scripts
        run: |
          set -e
          bash -n install/agentbox-install.sh
          bash -n bin/deploy-dashboard.sh
          bash -n bin/lib/custom-backend-files.sh
          for f in provisioning/*.sh mailbox/scripts/*.sh; do bash -n "$f"; done
```

**Verify**: run the same loop locally:
`bash -n install/agentbox-install.sh bin/deploy-dashboard.sh bin/lib/custom-backend-files.sh && for f in provisioning/*.sh mailbox/scripts/*.sh; do bash -n "$f" || echo "FAIL: $f"; done`
→ no `FAIL:` lines. If any script fails `bash -n`, STOP (see STOP conditions).

### Step 3: Remove the dead copy

Delete `mailbox/.github/workflows/ci.yml` (leave `publish-images.yml`).

**Verify**: `ls mailbox/.github/workflows/` → only `publish-images.yml`.

## Test plan

No unit tests — the deliverable is the workflow itself. The real test happens
on the first PR after this lands: both jobs (`dashboard`, `bash-syntax`) must
appear and pass. Note for the operator in your final report: **the repo secret
`GH_PACKAGES_TOKEN` must exist on the UMB-Advisors/AgentBOX repository** (it
existed on the old mailbox repo; it may not have been recreated here). Check:
`gh secret list --repo UMB-Advisors/AgentBOX` if `gh` is authenticated.

## Done criteria

- [ ] `.github/workflows/ci.yml` exists, parses as YAML, triggers on `main`
- [ ] `grep -c "working-directory: mailbox/dashboard" .github/workflows/ci.yml` ≥ 1
- [ ] `bash-syntax` job present: `grep -n "bash-syntax:" .github/workflows/ci.yml`
- [ ] `mailbox/.github/workflows/ci.yml` deleted
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any script fails `bash -n` in Step 2 — that's a pre-existing syntax error;
  report which file and line, do not fix it in this plan.
- `mailbox/.github/workflows/ci.yml` no longer matches the description above
  (someone already migrated it).
- You are tempted to "fix" the workflow's npm-token handling — the comment
  block in the file explains why it's shaped that way (MBOX-337); keep it.

## Maintenance notes

- `publish-images.yml` is still dead at `mailbox/.github/workflows/`; migrate
  it deliberately (it needs GHCR permissions) — deferred from this plan.
- Once CI is green on a PR, mark both jobs as required status checks in repo
  settings (operator action, not executor).
- Plan 010 adds shellcheck on top of the `bash -n` job; keep the job names
  stable so it can extend them.
- If the vitest suite is later split (e.g., pipeline smoke job per the
  deferred STAQPRO-134 notes at the bottom of the workflow), keep the schema
  snapshot step — DB-backed tests fail (not skip) without it.
