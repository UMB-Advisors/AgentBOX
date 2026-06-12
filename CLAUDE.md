# AgentBOX — Project Memory

Project-level instructions for Claude Code in this repo. Auto-loaded each session.
Extends the global `~/.claude/CLAUDE.md`.

> **⚠️ Two "dashboards" — don't confuse them (MBOX-469).** The **operator UI** is the **Hermes dashboard** (`hermes-agent-main/.../web`, served on `:9119`/tunnel `:9120`) — build new features there. The vendored **`mailbox/dashboard/`** (Next.js `mailbox-dashboard` container, `:3001`) is now the **headless MailBox pipeline backend** behind the hermes proxy (`/dashboard/*` → `:3001`): it serves n8n's ~33 `/api/internal/*` routes + proxied JSON, but its UI is retired/ported to Hermes. "Retiring mailbox-dashboard" = retiring its UI, **not** deleting the service. Don't rename the docker service (load-bearing DNS in 8 n8n workflows). See the `[STATE]` on MBOX-469.

**What this is:** the source-of-truth monorepo for **AgentBOX** — a unified edge-AI
appliance on a Jetson Orin Nano Super (8GB) co-residing the **MailBOX** email pipeline,
the **Hermes** agent, and the **gBrain** memory layer, served as one dashboard on `:9119`.
Decision (2026-06-06): AgentBOX **absorbs** the MailBOX stack (vendored at `mailbox/`).

## Project links

| What | Value |
|---|---|
| **GitHub** | [UMB-Advisors/AgentBOX](https://github.com/UMB-Advisors/AgentBOX) — `git@github.com:UMB-Advisors/AgentBOX.git` |
| **Linear workspace** | `staqs` |
| **Linear team** | Mailbox (`MBOX`) — id `cf4f1869-59fc-46bd-9a09-42be8514255f` |
| **Linear project** | [AgentBOX](https://linear.app/staqs/project/agentbox-ebf259fce6a4) — id `4f6a1297-848b-485e-88ef-ad4f675a1e7d` |
| **Linear initiative** | thUMBox Platform |
| **Linear MCP server** | `linear-staqs` (NOT `linear-server`) |

> **Linear migration (2026-06-07):** the AgentBOX project moved from the **UMB-Advisors**
> workspace to **staqs** and consolidated MailBOX + hermesBOX + Unified Inbox into the
> single AgentBOX project above. Issues are now `MBOX-*`. The old UMB-Advisors AgentBOX
> project is **canceled** — do not file there. Use the `linear-staqs` MCP tools.

## Commands

No unified test framework — this is an appliance/install repo (bash + vendored services).

```bash
# "Tests": syntax-check the install/deploy scripts (must pass before commit)
bash -n install/agentbox-install.sh bin/deploy-dashboard.sh bin/lib/custom-backend-files.sh

# Build/provision a fresh box (run ON the Jetson, from a clean checkout)
install/agentbox-install.sh --prototype          # bench: throwaway secrets, skip caddy

# Deploy/repair the custom dashboard to a running box (run from a dev machine)
REMOTE=mailbox2 bin/deploy-dashboard.sh                                   # agentbox1
REMOTE=UMB@100.127.2.54 RDIR=/home/UMB/.hermes/hermes-agent/hermes_cli \
  bin/deploy-dashboard.sh                                                 # agentbox2
bin/deploy-dashboard.sh --backend-only           # custom backend only, no web rebuild

# Verify the custom dashboard backend is live on a box (over its tunnel)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9119/api/google/auth/start  # 303 = OK
```

## Deploy Coordination — Simultaneous Builds (READ BEFORE DEPLOYING)

<important>
Multiple agents/sessions share ONE appliance per box. `bin/deploy-dashboard.sh`
does `rsync --delete web_dist` + restart with **NO lock and NO freshness check** —
last-writer-wins. On 2026-06-09 a peer agent building stale code (no Org Chart)
deployed `index-DsVtfbDA.js` over a fresh deploy and silently reverted it
("got squashed"). This is NOT a hermes auto-update — it is concurrent deploys
racing. Follow these rules:

1. **Deploy only from up-to-date `origin/main`.** Never deploy from a feature
   branch or worktree. Merge your PR first, then on the deploy checkout:
   `git fetch && git checkout main && git pull`, confirm
   `git rev-parse HEAD == git rev-parse origin/main`, THEN deploy. If your HEAD is
   **behind** `origin/main`, you are about to clobber newer work — STOP.
2. **One deploy at a time per box.** Before deploying, check nobody else is
   mid-deploy: `ssh <box> 'pgrep -af "hermes dashboard|rsync.*web_dist"'`. Wait
   if a deploy is in flight. (Box-side `flock ~/.hermes/deploy.lock` is the
   planned enforcement — see below.)
3. **Verify your deploy actually stuck.** After deploying, confirm the served
   bundle is YOURS and the feature is present:
   `ssh <box> 'grep -o "assets/index-[^\"]*\.js" <RDIR>/web_dist/index.html'`
   then grep that bundle for a string from your feature. If the hash changes
   seconds later, a peer clobbered you — re-coordinate, don't blindly re-deploy.
4. **Worktree isolation does NOT protect the shared box.** Worktrees only stop
   local build-file collisions; deploy contention is a separate hazard governed
   by rules 1–3. The same discipline applies to the mailbox-stack rebuild
   (`docker compose build mailbox-dashboard`).

**Enforcement (shipped):** `deploy-dashboard.sh` now has (a) `git fetch` + refuse
if `HEAD` is behind `origin/main`; (b) `flock` per-box deploy lock (re-exec); (c)
a `web_dist/DEPLOY_META` provenance stamp with a forward-only guard (refuse to
overwrite unless the new SHA contains the live SHA; `--force` to override).

**CI is the deployer (preferred path).** A self-hosted GitHub Actions runner
deploys `main` on merge — `.github/workflows/deploy-dashboard.yml`, set up via
`bin/register-ci-runner.sh`, runbook at `docs/ci-cd-deployer.v0.1.0.md`. **Once
the runner is registered, do NOT run `deploy-dashboard.sh` by hand** — merge to
`main` and let CI deploy. Manual `bin/deploy-dashboard.sh --force` is break-glass
only (CI down). This makes "one deployer, always from main" structural, not just
convention.
</important>

## Layout

- `install/agentbox-install.sh` — canonical fresh-box bring-up (staged). STAGE 7.6 overlays
  the AgentBOX-custom Hermes dashboard backend onto the stock install.
- `bin/deploy-dashboard.sh` — push the custom dashboard (frontend + backend) to a running box.
- `bin/lib/custom-backend-files.sh` — **single source of truth** for the custom-backend
  file set (git-derived). Consumed by both the installer and the deploy script.
- `hermes-agent-main/hermes-agent-main/` — vendored custom Hermes fork (stock import +
  AgentBOX dashboard commits). Custom backend = `hermes_cli/*.py` diverging from the import.
- `mailbox/` — vendored MailBOX email stack (compose, dashboard, n8n).
- `gbrain-master/gbrain-master/` — vendored gBrain memory layer.
- `provisioning/`, `systemd/`, `config/` — staged provisioning steps, boot units, templates.
- `docs/` — PRDs, the JP7.2 reproduction runbook, ADR-style addendums, STATE files.

## Appliance topology

- **agentbox1** = host `mailbox2` (ssh user `mailbox`, `/home/mailbox`) — the reference box.
- **agentbox2** = host `UMB@100.127.2.54` (`/home/UMB`) — JP7.2 unified build.
- Dashboard is loopback-bound on `:9119`; reach it via SSH tunnel (`ssh -L <port>:127.0.0.1:9119 <box>`)
  or Tailscale Funnel. Client-facing branded URL is tracked in **MBOX-451**.

## Conventions

- Hermes is **pinned to v0.15.1** (`HERMES_REF=927fa7a98`); 0.16's ≥64K context floor breaks
  the local Qwen3-4B. Do not bump without revisiting the model context plan.
- `web_dist` is a gitignored build artifact — never committed; built during install/deploy.
- File issues in the **staqs / AgentBOX** project via `linear-staqs`.
