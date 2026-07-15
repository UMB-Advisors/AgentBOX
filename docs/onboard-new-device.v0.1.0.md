# Onboarding a new AgentBOX — provisioning runbook (v0.2.0)

**Revised 2026-07-14** (post fresh-flash audit; supersedes v0.1.0). Repeatable flow to
stand up device #N with phone-onboarding + a per-box reach-me link.

> **⚠️ Readiness.** The individual pieces are built + syntax/unit-clean, but the FULL
> fresh-flash → user-ready path has **not yet run end-to-end on hardware**. The three
> code-complete-but-unproven gates are the phone **OOBE finalizer** (join WiFi + connect
> mailbox after the AP drops), the **captive portal**, and **`provision-box.sh`'s first
> Railway run**. Treat the first real provision as the verification run — expect to iron
> out issues. A finalizer **recovery path** now exists: a failed WiFi join re-raises the
> setup AP instead of stranding the box.

This is a **two-machine** flow (box + operator laptop) with **interactive `sudo` on the
box** (the box user has no passwordless sudo). There is no single unattended command.

## Branches (use these — not the old feature branches)
- Monorepo: **`demo/agentbox`** (the only branch with install + AP + `infra/relay-poc/`).
- Sidecar: **`feat/onboarding-oobe`**.
`onboarding-test-setup.sh` now pulls these (fixed `MONO_BRANCH`).

## Prerequisites
- **Operator laptop:** `railway login`; key-based `ssh <box>` (via Tailscale once §2 done);
  a GitHub token for the private sidecar clone (`AB_GH_TOKEN`).
- **Box:** flashed AgentBOX image with the monorepo already cloned at `~/AgentBOX`
  (the flash tooling does this — nothing in-repo bootstraps the first monorepo clone);
  on a network for provisioning; `sudo` password known.

## Steps

### 1. (Box, interactive) Base appliance + sidecar/onboarding install
On the box console (sudo prompts):
```bash
cd ~/AgentBOX && git checkout demo/agentbox
install/agentbox-install.sh                       # full appliance (--prototype on a bench box)
AB_GH_TOKEN=<gh-token> install/onboarding-test-setup.sh   # sidecar (:9200) + wizard + AP + sudoers + state dir
```
- `agentbox-install.sh` STAGE 0.2 now **persists Tailscale auto-rejoin** (`tailscaled` enabled
  + `up --ssh --hostname=<tailnet-name>`); STAGE 0.3 installs the onboarding AP + captive plumbing.
- `onboarding-test-setup.sh` clones/updates both repos at the branches above, installs Node22/
  pnpm9/uv, **builds the UI on-box**, installs the systemd user units + the `nmcli` sudoers rule +
  `/var/lib/agentbox` (in that order — the sidecar needs them before it can do the WiFi join), and
  starts the sidecar. Verify: `curl 127.0.0.1:9200/healthz`.
> The base installer alone does NOT bring up the sidecar (`:9200`) — that's this second script.

### 2. (Operator) Enroll on the tailnet as `tag:box`
The ACL already has the `tag:box` tagOwner + anti-lockout SSH rule, so a new box just needs tagging
(no per-box sudo):
```bash
curl -X POST -H "Authorization: Bearer $TS_API_KEY" -H 'Content-Type: application/json' \
  --data '{"tags":["tag:box"]}' https://api.tailscale.com/api/v2/device/<device-id>/tags
```
Confirm `ssh <box>` works. (Detail: `infra/relay-poc/notes/phase1-tailscale.md`.)

### 3. (Operator) Provision per-box relay reachability
From `infra/relay-poc/` (needs `railway login`):
```bash
./provision-box.sh <boxid> <ssh-host>      # e.g. ./provision-box.sh agentbox2 agentbox2
```
Mints a per-box 256-bit token; creates + deploys that box's own root-mount Railway service (its own
URL); writes `~/.config/relay-poc/env` (mode 600, token over SSH — never printed); installs the
self-healing box-client. **Creates a real (billable) Railway service. First run is unproven — watch it.**

### 4. (Customer, phone) The OOBE
Take the box **offline** so the AP fires (`sudo nmcli connection delete "<home-wifi>"; sudo reboot`,
or `sudo systemctl start agentbox-onboarding-ap` after going offline). Join **"AgentBOX-Setup"** →
captive portal auto-opens the wizard (fallback: `http://10.42.0.1:9200/onboarding`) → welcome → pick
WiFi + password → mailbox → **Finish**. Everything is saved-then-applied (single radio: the box stays
on the AP the whole time). On Finish the box joins WiFi, connects mail, drops the AP, and the complete
screen shows the **reach-me link + QR**.

### 5. Verify
- `curl https://<relay-host>/__relay/health` → the box id in `boxes`.
- Phone on cellular: `https://<relay-host>/?key=<token>` → the dashboard renders.

## Ordering / gotchas
- Run §1 (box) **before** §3 (which SSHes in). §2 (Tailscale) gives you that SSH.
- The reach-me card silently shows nothing if `~/.config/relay-poc/env` is absent — §3 writes it; §4 reads it.
- `HERMES_MAIL_SECRET_KEY` (auto-generated in the installer) must exist or the mailbox step 500s.

## Known limits
- **One Railway service per box** (root-mount, because the SPA needs a URL root). Per-box **subdomains**
  on one relay is the scale-up, gated on a branded/wildcard domain (**MBOX-451**).
- **`/hermes/` returns 502** through the relay unless the Hermes upstream (`:9119`) is actually running —
  the relay serves the dashboard shell; scope the demo accordingly.
- Reach-me token is a long-lived bearer credential shown to + saved by the user → Phase 2:
  rotation/revocation, rate-limit, the relay-vs-libtailscale data-path-privacy decision (deferred).
- Non-`--prototype` installs need a **1Password** session (secrets) and a **Gmail OAuth** browser consent
  — irreducibly manual.
- Re-provisioning a box cleanly: delete its Railway service first (rotates the token), then re-run §3.
</content>
