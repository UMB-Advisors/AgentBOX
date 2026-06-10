# CI/CD Single-Deployer — Runbook v0.1.0

**Date:** 2026-06-09
**What:** auto-deploy the AgentBOX dashboard to the appliance(s) on every merge to
`main`, via a self-hosted GitHub Actions runner. Replaces hand-run
`bin/deploy-dashboard.sh` (the source of the concurrent-deploy clobbers).

## TL;DR
Merge to `main` → GitHub workflow `deploy-dashboard.yml` runs on **one**
self-hosted runner (your workstation) → it builds web + runs the guarded
`bin/deploy-dashboard.sh` to the box. One deployer, always from `main` → no
races, no stale clobbers. Manual deploys become break-glass only.

## Why this model (self-hosted runner on the workstation)
- **Builds on capable hardware**, not the 8GB Jetson (Vite build + memory pressure).
- **Reuses the working path**: the runner is your workstation, which already has
  Tailscale SSH to the boxes, your SSH keys, and a working npm/registry config —
  so **no SSH or Tailscale secrets need to live in GitHub**.
- **Reuses the guarded script** (`deploy-dashboard.sh`): flock + origin/main
  freshness + DEPLOY_META forward-only stay as a safety net under CI.

Alternatives considered: GitHub-hosted runner + Tailscale (needs TS + SSH secrets,
builds in cloud) and an on-box systemd pull-deployer (simplest networking but
builds on the Jetson). Either can be adopted later; the workflow/script split
makes switching cheap.

## Components
| File | Role |
|---|---|
| `.github/workflows/deploy-dashboard.yml` | The recipe: on push to `main` (dashboard paths) → checkout → Node 22 → `npm ci` → `deploy-dashboard.sh` per box. `concurrency` serializes runs; `matrix.box` lists appliances. |
| `bin/register-ci-runner.sh` | One-time: download + configure + service-install a self-hosted runner labeled `agentbox-deploy`. |
| `bin/deploy-dashboard.sh` | Unchanged deploy logic + the flock/freshness/forward-only guards (PR #35). |

## One-time setup (you, on the workstation)
1. **Push the workflow to `main`** (this PR). The workflow file must be on the
   default branch for the `push` trigger to be active.
2. **Get a runner registration token:** repo → **Settings → Actions → Runners →
   New self-hosted runner** → Linux/x64 → copy the token from the shown
   `./config.sh --token <T>` line (expires ~1h).
3. **Register the runner** (run as the user with box SSH access, e.g. your normal
   login — it needs your SSH keys + Tailscale):
   ```bash
   bin/register-ci-runner.sh <REGISTRATION_TOKEN>
   ```
   Verify it shows **Idle** under Settings → Actions → Runners.
4. **Test:** Actions tab → "Deploy dashboard" → **Run workflow** (manual
   `workflow_dispatch`) → watch it build + deploy to agentbox2.

## Operations
- **Normal flow:** open PR → merge to `main` → deploy runs automatically. Watch
  it in the **Actions** tab. The job log ends with `OK: AgentBOX dashboard
  deployed`.
- **Add agentbox1:** uncomment the agentbox1 entry in the workflow `matrix.box`.
- **Manual trigger:** Actions → Deploy dashboard → Run workflow.
- **Break-glass (CI down):** run `bin/deploy-dashboard.sh --force` locally. Only
  when CI can't — manual + concurrent is exactly what caused the clobbers.

## Failure modes & guards
- **Broken `main` build** → the job fails at `npm run build`; `set -e` aborts
  **before** any box is touched. Nothing deploys. Fix `main`, re-merge.
- **Two merges close together** → second deploy queues (`concurrency` +
  flock); never overlap.
- **Runner offline** (workstation off) → deploys don't run; the Action queues
  until the runner is back, or trigger manually later. Consider the GH-hosted +
  Tailscale model if the workstation isn't reliably on.
- **A stale/divergent deploy** → the script's freshness + forward-only guards
  abort it; CI always deploys a fresh `main` checkout so these are no-ops in the
  happy path.

## Caveats
- Auto-deploy-on-merge means **`main` must stay deployable.** Keep PRs green;
  the build gate (job fails → no deploy) is the backstop, not a substitute for review.
- The runner runs as your user — treat the workstation as deploy-trusted.
- Pushing workflow files needs a token with the `workflow` scope.
