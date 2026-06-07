# AgentBOX — Project Memory

Project-level instructions for Claude Code in this repo. Auto-loaded each session.
Extends the global `~/.claude/CLAUDE.md`.

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
