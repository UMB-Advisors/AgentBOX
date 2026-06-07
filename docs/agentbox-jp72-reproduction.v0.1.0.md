# AgentBOX — JetPack 7.2 / CUDA 13 Build Runbook (Source of Truth)

> **Created:** 2026-06-06
> **Status:** v0.1.0 — first JP7.2 bring-up validated on `agentbox2`
> **⚠ Amended by [Addendum 001 — Absorb MailBOX into the monorepo](./addendum-agentbox-absorb-monorepo-v0_1-2026-06-07.md)** (2026-06-07): the MailBOX stack is now **vendored** at `mailbox/`, not cloned; STAGE 0.5 syncs it; `hermes-gateway.service` added. Read the addendum alongside this runbook.
> **Scope:** This repo (**AgentBOX**) is the source of truth for the unified
> appliance = **MailBOX email stack + Hermes agent + gBrain**, on one Jetson.
> The MailBOX app stack is a separate repo, **cloned** by the installer
> (`install/agentbox-install.sh`, decision `dc8de53`); AgentBOX owns the
> orchestration, Hermes/gBrain wiring, compose override, systemd units, and the
> JetPack reflash + flash skill.

## TL;DR — set up a new AgentBOX

Flashed Jetson (JP7.2), then one command:
```
git clone https://github.com/UMB-Advisors/AgentBOX.git ~/agentbox && cd ~/agentbox
install/agentbox-install.sh --prototype        # bench: throwaway secrets, skip caddy
```
From bare hardware, use the flash skill instead: **`/agentbox-flash`** (drives
recovery-mode detect → flash → host prep → clone → install, stopping at the 3
human steps: recovery jumper, Gmail OAuth, 1Password unlock).

## What the installer does (stages)

| Stage | Action |
|---|---|
| 0 | preconditions + **JP7.2 base prep**: register nvidia runtime (`nvidia-ctk`), disk/docker checks |
| 0.5 | **clone the MailBOX stack** (`MAILBOX_GIT_REF`) into `~/mailbox`; apply `config/docker-compose.override.yml.template` (loopback publishes) |
| 1–2 | secrets/.env (prototype throwaway or 1Password); base services (postgres, qdrant, **one ollama**, DR-64) |
| 3–4 | canonical DB schema; models (`qwen3:4b-instruct`, `qwen3:4b-ctx4k`, `nomic-embed-text:v1.5`) |
| 5 | dashboard + n8n (+caddy). **Dashboard image:** build from source (needs a real `GITHUB_PACKAGES_TOKEN`) **or** preload (`DASHBOARD_IMAGE` / `docker save\|load mailbox-dashboard:local`) |
| 6 | n8n Postgres credential + import + activate the 4 workflows |
| 7 | **Hermes**: install + **pin v0.15.1** (`HERMES_REF`), deploy `config/hermes/config.yaml.template`, **gBrain** (vendored src + pglite brain) |
| 7.5 | build + install the **custom** dashboard web dist from vendored `hermes-agent-main/web` (stock build only as fallback) |
| 7.6 | **overlay the AgentBOX-custom backend** onto the stock Hermes install — `web_server.py` + `google_*/shopify_*` helpers + `dashboard_auth/public_paths.py`. Without this, stock Hermes has no `/api/google/*` routes and **Connect Google 404s**. File set = git-derived SoT in `bin/lib/custom-backend-files.sh`; same set `bin/deploy-dashboard.sh` pushes for post-`hermes update` repairs |
| 8 | **boot-to-ready**: install `systemd/{agentbox,hermes-dashboard,hermes-gateway}.service` + enable-linger |

## Why these JP7.2 / version specifics

- **nvidia runtime registration** — JP7.2/r39 ships the toolkit but leaves it unregistered; GPU containers fail with "unknown runtime: nvidia" until `nvidia-ctk runtime configure`.
- **Hermes pinned to v0.15.1** (`HERMES_REF=927fa7a98`) — **0.16.0 enforces a ≥64K context floor** that rejects the local Qwen3-4B (Modelfile ctx 4096); 0.15.1 serves it on GPU within the 8 GB SM-97 envelope.
- **Single Ollama (DR-64)** — gBrain embeddings + Hermes chat both use the one dockerized Ollama published on `127.0.0.1:11435`; no separate host Ollama required.
- **Dashboard token** — `.env.example` ships a placeholder `GITHUB_PACKAGES_TOKEN`; a from-source build needs a real `read:packages` token. Offline/no-token boxes preload the prebuilt arm64 image (it's CUDA-free, so no JP7.2 risk).

## Verify
```
systemctl --user is-active agentbox.service hermes-dashboard.service   # active active
cd ~/mailbox && docker compose ps                                      # 5 healthy
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9119/        # 200
hermes -z 'Reply with one word: BANANA' --yolo --accept-hooks          # BANANA
hermes mcp list                                                        # gbrain ✓ enabled
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9119/api/google/auth/start  # 303 (custom backend live; 401/404 = stock)
```
If `/api/google/auth/start` returns 401/404, the custom backend overlay (STAGE 7.6)
didn't take — re-run the installer, or from a dev machine:
`REMOTE=<user>@<box> RDIR=/home/<user>/.hermes/hermes-agent/hermes_cli bin/deploy-dashboard.sh`.
Connecting an account also needs `google_client_secret.json` in `$HERMES_HOME/` and
the box's callback URL registered in the GCP OAuth client (operator step).
The `:9119` dashboard is loopback-bound by design; view it over the tailnet via an SSH tunnel:
`ssh -L 9120:127.0.0.1:9119 <user>@<box>` → http://localhost:9120

## Remaining (operator / fresh-state, not bench-automatable)
Gmail OAuth (browser consent, per inbox); n8n credential re-link + workflow activation; qdrant collection bootstrap; OpenRouter/OpenAI fallback keys; rotate the appliance login/sudo password off any default. Optional: `hermes gateway` for messaging platforms.

## Provenance
First validated fresh on `agentbox2` (JP7.2 / L4T r39.2 / CUDA 13) on 2026-06-06, reproducing the `agentbox1` ground truth (the `:9119` unified appliance). Earlier drift fixes were initially staged in the mailbox repo (PR #236) and re-homed here, since AgentBOX owns the override / Hermes wiring / systemd under the "AgentBOX-clones-MailBOX" design.
