# AgentBOX — Project Memory

Project-level instructions for Claude Code in this repo. Auto-loaded each session.
Extends the global `~/.claude/CLAUDE.md`.

> **⚠️ Build target (updated 2026-06-12).** The operator UI + ALL custom features live in **`UMB-Advisors/agentbox-sidecar`** (FastAPI `:9200`, systemd `agentbox-sidecar.service`; vendored UI at `web/` served at `/`; stock hermes demoted to `/hermes/`). Tunnel `:9120` → `:9200`. **NEVER add features to hermes `web_server.py`/`hermes_cli`** — use the sidecar or `~/.hermes/plugins`. `hermes-agent-main/` in this repo is a **STALE DUPLICATE** (history/rollback only).
>
> **⚠️ Two "dashboards" — don't confuse them (MBOX-469).** The vendored **`mailbox/dashboard/`** (Next.js `mailbox-dashboard` container, `:3001`) is the **headless MailBox pipeline backend** behind the hermes proxy (`/dashboard/*` → `:3001`): it serves n8n's ~33 `/api/internal/*` routes + proxied JSON, but its UI is retired. "Retiring mailbox-dashboard" = retiring its UI, **not** deleting the service. Don't rename the docker service (load-bearing DNS in 8 n8n workflows). See the `[STATE]` on MBOX-469.

**What this is:** the source-of-truth monorepo for **AgentBOX** — a unified edge-AI
appliance on a Jetson Orin Nano Super (8GB) co-residing the **MailBOX** email pipeline,
the **Hermes** agent, and the **gBrain** memory layer. The user-facing front door is the
**agentbox-sidecar on `:9200`**; hermes `:9119` sits behind the sidecar's transparent proxy.
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

# Deploys: custom features/UI deploy from the agentbox-sidecar repo, per
# agentbox-sidecar/docs/update-runbook.md. This monorepo does NOT deploy the dashboard.

# Liveness check
curl -s 127.0.0.1:9200/healthz     # on the box
curl -s localhost:9120/healthz     # via the tunnel
```

## Deploys (updated 2026-06-12)

This monorepo **no longer deploys the dashboard**. `bin/deploy-dashboard.sh` and
`.github/workflows/deploy-dashboard.yml` are **DECOMMISSIONED** (tombstone-gated /
`workflow_dispatch`-only; they targeted the retired hermes_cli-overlay architecture
and the rollback-only checkout `~/.hermes/hermes-agent`). Custom-feature deploys
happen from the **agentbox-sidecar** repo per its `docs/update-runbook.md`.

<details>
<summary>History — old single-deployer protocol (pre-sidecar, for the record)</summary>

Multiple agents/sessions share ONE appliance per box. `bin/deploy-dashboard.sh`
did `rsync --delete web_dist` + restart; concurrent deploys raced (last-writer-wins;
a 2026-06-09 stale deploy "squashed" a fresh one). Mitigations shipped: deploy only
from up-to-date `origin/main`; one deploy at a time per box (`flock` per-box lock);
verify the served bundle after deploying (`web_dist/DEPLOY_META` provenance stamp
with a forward-only guard); worktree isolation does not protect the shared box.
Finally a self-hosted runner (`agentbox-deploy`) made CI the single deployer
(`.github/workflows/deploy-dashboard.yml`, `bin/register-ci-runner.sh`,
`docs/ci-cd-deployer.v0.1.0.md`), with manual `--force` as break-glass.
The lesson ("one deployer, always from main") carries over to the sidecar repo.

</details>

## Layout

- `install/agentbox-install.sh` — canonical fresh-box bring-up (staged). STAGE 7.6 overlays
  the AgentBOX-custom Hermes dashboard backend onto the stock install.
- `bin/deploy-dashboard.sh` — push the custom dashboard (frontend + backend) to a running box.
- `bin/lib/custom-backend-files.sh` — **single source of truth** for the custom-backend
  file set (git-derived). Consumed by both the installer and the deploy script.
- `hermes-agent-main/hermes-agent-main/` — **stale duplicate of the UI source** (vendored
  custom Hermes fork, history/rollback only). Source of truth = `agentbox-sidecar/web`;
  the custom `hermes_cli` overlay pattern is dead.
- `mailbox/` — vendored MailBOX email stack (compose, dashboard, n8n).
- `gbrain-master/gbrain-master/` — vendored gBrain memory layer.
- `provisioning/`, `systemd/`, `config/` — staged provisioning steps, boot units, templates.
- `docs/` — PRDs, the JP7.2 reproduction runbook, ADR-style addendums, STATE files.

## Appliance topology

- **agentbox1** = host `mailbox2` (ssh user `mailbox`, `/home/mailbox`) — likely still the
  pre-sidecar architecture (v0.15.1 fork, dashboard on `:9119`) — **DIVERGENT** from
  agentbox2; disposition TBD (see MBOX-425 comment / U8).
- **agentbox2** = host `UMB@100.127.2.54` (`/home/UMB`) — JP7.2 unified build. UI = the
  **sidecar on `:9200`**; tunnel `:9120` via systemd user unit `agentbox2-tunnel.service`
  (never ad-hoc `ssh -L`); stock hermes UI at `/hermes/`.
- Client-facing branded URL is tracked in **MBOX-451**.

## Conventions

- agentbox2 runs **upstream hermes v0.16.0** (`88dbf9510`, branch `agentbox2-v3` in
  `UMB-Advisors/agentbox-hermes-patches` = upstream + one `/dashboard` proxy patch).
  Pin management lives in that repo. (Historical: the repo pinned v0.15.1
  `HERMES_REF=927fa7a98` because 0.16's ≥64K context floor was thought to break the
  local Qwen3-4B — verify on box how that was resolved before relying on the local model.)
- `web_dist` is a gitignored build artifact — never committed; built during install/deploy.
- File issues in the **staqs / AgentBOX** project via `linear-staqs`.
