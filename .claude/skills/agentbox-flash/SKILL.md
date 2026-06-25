---
name: agentbox-flash
description: "ALWAYS use this skill to provision a blank NVIDIA Jetson into a fully set-up AgentBOX when the board is attached to this host over USB. Trigger on 'flash the jetson', 'provision a new agentbox', 'set up a blank jetson', 'turn this jetson into an agentbox', 'image the box', or any request to go from bare hardware → green AgentBOX. Drives the automatable spine (detect board in recovery mode, flash Jetson Linux to NVMe, reach the box over USB device-mode networking, host prep, clone the repo from GitHub, run agentbox-install.sh) and STOPS cleanly at the three steps a human must do (recovery-mode jumper, Gmail OAuth consent, 1Password unlock). Do NOT use for re-running the installer on an already-flashed box (run install/agentbox-install.sh directly) or for non-Jetson hosts."
user_invocable: true
argument-hint: "[--prototype] [--prod] [--resume <stage>]"
---

# /agentbox-flash — Blank Jetson → fully set-up AgentBOX

> **⚠️ CAVEAT (2026-06-12):** `install/agentbox-install.sh` currently provisions the
> **PRE-SIDECAR** architecture (v0.15.1 pin + hermes_cli overlay, no sidecar). After
> install, follow the **agentbox-sidecar** setup (service `:9200`, plugins, postupdate
> healthcheck) — see the agentbox-sidecar decoupling PRD + `agentbox-sidecar/docs/update-runbook.md`.
> This caveat stands until the installer rework (MBOX-428) lands.

You provision a bare NVIDIA Jetson Orin Nano Super 8 GB into a working AgentBOX,
driving everything that can be automated and gating cleanly on the three steps a
human must physically do. **GitHub is the source of truth** — the box clones this
repo and runs its own `install/agentbox-install.sh`. The companion script
`provision-jetson.sh` is the engine; this file is the playbook that tells you
when to run it, what to check, and where to stop for the operator.

## Honest scope — what is and isn't automatic

Three steps **require a human** and the run will block on them. Surface them up
front; never pretend they're automated:

1. **Recovery mode** — the operator must hold FC REC + tap power (or fit the
   FC-REC jumper) at power-on so the board enumerates over USB. You cannot do
   this in software. You *detect* the result (`lsusb` shows `0955:*` APX), you
   don't cause it.
2. **Gmail OAuth consent** — a browser sign-in per inbox. Not headless-able.
3. **1Password unlock** (production only) — `op signin` for the real secrets.
   Bench runs skip this with `--prototype`.

Everything between those — flashing, reaching the box, host prep, the GitHub
clone, and the full `agentbox-install.sh` — is scripted and idempotent.

## Inputs you need before starting

Read `provision.env` (copy from `provision.env.example`) and confirm with the
operator. Load-bearing values:

| Var | Why it matters |
|-----|----------------|
| `BSP_DIR` | Path to an extracted `Linux_for_Tegra/` (Jetson Linux BSP + sample rootfs, `apply_binaries.sh` already run). |
| `BOARD_CONFIG` | `jetson-orin-nano-devkit-super` for JetPack 6.1+; `jetson-orin-nano-devkit` otherwise. Wrong value = failed flash. |
| `TARGET_DEVICE` | `nvme0n1p1` (NVMe, strongly preferred — installer needs ≥16 GB free) or `internal` for eMMC/SD. |
| `BOX_USER` / `BOX_PASS` / `BOX_HOST` | Baked into the rootfs so first boot skips interactive `oem-config` and you can SSH in headless. |
| `AGENTBOX_GIT_URL` / `AGENTBOX_GIT_REF` | Repo the box clones. Defaults to `UMB-Advisors/AgentBOX` (installer is on `main`). `GIT_TOKEN` for a private repo. |
| `INSTALL_MODE` | `--prototype` (throwaway secrets, gate bypass, no Caddy) or production (1Password + live gate ON). |
| `GITHUB_PACKAGES_TOKEN` | **Mandatory** — the installer dies without it (dashboard image builds against GHCR). |

If `provision.env` is missing, copy the example, fill what you can infer, and ask
the operator only for the genuinely unknown values (token, board variant, NVMe).

## The stages

The script is staged and resumable (`--resume <stage>`). Run it stage-by-stage,
read the output, and only advance when the prior stage is green.

```
0 preflight   → host deps + board visible in recovery mode (USB)
1 mkuser      → bake default user into rootfs (skip oem-config)   [human did recovery mode]
2 flash       → l4t_initrd_flash Jetson Linux to NVMe              ~8–15 min
3 reach       → wait for boot, SSH over USB device-mode 192.168.55.1
4 hostprep    → apt, docker nvidia default-runtime, disk, git, internet
5 deploy      → box git-clones the repo from GitHub, runs install/agentbox-install.sh
6 report      → docker compose ps + the human gates that remain
```

### Stage 0 — preflight
`provision-jetson.sh --stage preflight`. Checks host tools and greps `lsusb`
for an APX device (`0955:`). **If no APX device:** the board is not in recovery
mode — tell the operator to power off, hold FORCE RECOVERY, tap power (or fit the
jumper), and re-run. Human gate #1.

### Stage 1 — mkuser
`--stage mkuser` runs `l4t_create_default_user.sh` so the flashed image boots
straight to a usable, SSH-able account. Idempotent.

### Stage 2 — flash
`--stage flash` runs `l4t_initrd_flash.sh` for NVMe (or `flash.sh` for internal).
The long pole (~8–15 min). On failure suspect wrong `BOARD_CONFIG`, board dropped
out of recovery (use a direct USB port, not a hub), or NVMe not seated.

### Stage 3 — reach
After flash the USB cable carries **device-mode networking**: the Jetson is
`192.168.55.1`, this host auto-gets `192.168.55.100`. `--stage reach` polls SSH
on `192.168.55.1` (falls back to `<BOX_HOST>.local` over LAN). Up to 5 min.

### Stage 4 — hostprep
`--stage hostprep` SSHes in and makes the box installer-ready: apt update, ensure
Docker with **nvidia as default-runtime** (installer STAGE 0 requires it), confirm
the box has **internet** (it must pull models + the GHCR image) and ≥16 GB free,
install git.

### Stage 5 — deploy
`--stage deploy` has the box **`git clone` the repo from GitHub** (`AGENTBOX_GIT_URL`
@ `AGENTBOX_GIT_REF`) into `~/agentbox`, seeds `GITHUB_PACKAGES_TOKEN` into `.env`,
and runs `install/agentbox-install.sh INSTALL_MODE` there. The installer owns DB
bootstrap, models, stack-up, and n8n import/activate — stream its staged log.
(`DEPLOY_SOURCE=local` rsyncs a local checkout instead, for offline/dev.)

**Production gate:** the installer's STAGE 1 calls `op read ...`. If 1Password is
locked it dies — have the operator `op signin` first (human gate #3), or use
`--prototype`.

### Stage 6 — report
`--stage report` prints `docker compose ps` + the drafts-table check, then **you**
summarize the manual steps that remain:

- **Gmail OAuth** consent in a browser, per inbox (human gate #2).
- **GCP**: enable Gmail API + add the redirect URI for the OAuth client.
- **Tailscale Funnel → basic_auth Caddy → n8n** (`config/Caddyfile.funnel.template`).
- **Hermes client-mode confirm**: `hermes doctor` + `ollama ps` show only
  `nomic-embed-text` + `qwen3:4b-ctx4k`.
- **systemd `agentbox.target`** for boot-to-ready ≤5 min (production).

## Smoke tests to confirm green
- Inject an inbound → a draft appears in the dashboard approval queue.
- `hermes -z` replies.
- Optionally re-run the SM-97 worst-case spike to spot-check the RAM envelope.

## Rules
- **Never claim a step you didn't run.** Echo the actual stage output.
- **Stop at every human gate** with a one-line instruction; don't spin.
- Prefer `--prototype` unless the operator explicitly asks for a production box.
- Treat the script as idempotent: on any failure, fix the cause and re-run that
  stage with `--resume`, don't restart from zero.
- Confirm `BOARD_CONFIG`, `TARGET_DEVICE`, and `BSP_DIR` with the operator before
  Stage 2 — a wrong board config can brick a boot partition.
