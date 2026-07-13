# Onboarding a new AgentBOX — replicable runbook (v0.1.0)

**Date:** 2026-07-13. Repeatable flow for standing up device #N with its own
phone-onboarding + reach-me link. Fleet model per plan 018 Phase 1: **one per-box
token + one root-mounted relay service per box** (subdomains-on-one-relay is the
later scale-up, gated on a branded/wildcard domain — MBOX-451).

## Prerequisites
- Operator machine: `railway login` done; `ssh` access to the box; this repo checked out.
- Box: flashed with the AgentBOX image; on a network for provisioning (ethernet or a
  temporary WiFi); node installed.

## Steps

### 1. Base install (flash-time)
Clone the monorepo on the box and run the installer:
```bash
install/agentbox-install.sh            # (--prototype on a bench box)
```
This now (STAGE 0.2) **persists Tailscale auto-rejoin** — `tailscaled` enabled +
`up --ssh --hostname=<box>` — so the box rejoins the tailnet on every reboot with no
manual `tailscale up`. STAGE 0.3 installs the onboarding WiFi-AP + captive portal.

### 2. Enroll on the tailnet as `tag:box`
Per-box Tailscale enrollment (admin path, no per-box sudo). See
`infra/relay-poc/notes/phase1-tailscale.md` — the ACL already carries the `tag:box`
tagOwner + anti-lockout SSH rule, so a new box just needs tagging (admin API
`POST /device/<id>/tags {"tags":["tag:box"]}`). Confirm `ssh <box>` works afterward.

### 3. Provision per-box relay reachability (the replicable one-liner)
From `infra/relay-poc/` on the operator machine:
```bash
./provision-box.sh <boxid> <ssh-host>      # e.g. ./provision-box.sh agentbox2 agentbox2
```
This: mints a **per-box 256-bit token**; creates + deploys a root-mounted Railway
relay service `relay-<boxid>` (its own URL); writes the box's
`~/.config/relay-poc/env` (mode 600, token over SSH stdin — never printed); installs
the self-healing box-client as a `--user` systemd service; and verifies the box
registers on its relay. **Creating a Railway service is a real (billable) action.**

### 4. Onboard from the phone (OOBE)
Take the box **offline** so the AP fires (`sudo nmcli connection delete "<wifi>"; sudo reboot`,
or `systemctl start agentbox-onboarding-ap` after going offline). Join the
**"AgentBOX-Setup"** hotspot → the captive portal auto-opens the wizard → pick WiFi +
mailbox → **Finish**. On the complete step the phone shows the **reach-me link + QR**
(that box's own URL/token, from step 3). The box joins WiFi, connects mail, and drops
the AP.

### 5. Verify
- Relay sees the box: `curl https://<relay-host>/__relay/health` → box id in `boxes`.
- From a phone on cellular: open `https://<relay-host>/?key=<token>` → the box dashboard.

## Notes / current limits
- **One Railway service per box** (root-mount). At fleet scale, migrate to per-box
  subdomains on one relay once MBOX-451 (branded/wildcard domain) lands.
- The reach-me token is a long-lived bearer credential shown to + saved by the user.
  Phase 2: rotation/revocation ("regenerate my link") + rate-limit + the data-path
  privacy decision (relay vs libtailscale, deferred).
- Re-provisioning an existing box: delete its Railway service first for a clean token
  rotation, then re-run step 3.
