# AgentBOX demo runbook — show the full flow from scratch

How to drive the end-to-end AgentBOX experience — bare Jetson → provisioned box →
phone out-of-box onboarding (OOBE) → (optional) off-LAN reach-me — and how to
reset it to re-demo. For developers / demos / testing.

> **Status:** the scripted path is statically verified (round-3 audit: CONVERGED
> on the scripted LAN-onboard path). The one integrated hardware run from a clean
> flash is the remaining thing that certifies it end to end.

---

## The one gotcha to know

The flash **deliberately leaves the box online, not in AP mode**. `provision-jetson.sh`
sets `AB_SKIP_AP_REBOOT=1` so the box doesn't reboot into the setup hotspot and sever
the flash's own ssh session mid-run. So right after provisioning, the box is fully
installed and sitting on your LAN — **not** broadcasting the setup Wi-Fi.

`demo-reset.sh --reboot` is what flips a provisioned box into the customer's
first-boot AP/OOBE state. It's a required step even on a brand-new box.

---

## Scenario A — from a bare Jetson (full flow)

| # | Where | Do this | Result |
|---|-------|---------|--------|
| 1 | Flash + first boot | Flash JetPack 7.2 per **[`flash-jetson.md`](./flash-jetson.md)** (NVIDIA ISO installer: write installer to USB with Etcher → boot the Jetson → **confirm the QSPI capsule update, press `Y`** → install to **NVMe** → first-boot `oem-config`). Then **enable SSH** (`sudo apt install -y openssh-server`) and connect it to your network (Wi-Fi/Ethernet, DHCP). | booted box, SSH-reachable on your LAN |
| 2 | On the box (SSH) | Clone the repo and run the OOBE install, staying online (don't flip to AP yet). Needs a GitHub token — `GIT_TOKEN` (`repo`) for the private sidecar clone + `GITHUB_PACKAGES_TOKEN` (`read:packages`) for the dashboard build (one PAT with both scopes works). <br>`git clone https://github.com/UMB-Advisors/AgentBOX.git ~/AgentBOX`<br>`AB_GH_TOKEN=<token> AB_SKIP_AP_REBOOT=1 ~/AgentBOX/install/onboarding-test-setup.sh` | installs sidecar + OOBE wizard + Wi-Fi-AP, builds the UI, gates `:9200` → **green `:9200`, box online on your LAN** (not yet in AP mode) |
| 3 | On the box | `~/AgentBOX/install/demo-reset.sh --seed-demo --reboot` (run once with `--dry-run` first to preview) | clears onboarding + connected accounts, **seeds a demo inbox**, takes Wi-Fi offline, reboots → ~90 s later broadcasts **`AgentBOX-Setup-XXXX`** |
| 4 | Phone | Join `AgentBOX-Setup-XXXX` (open, no password). Open **`http://10.42.0.1:9200/onboarding`**. Walk the wizard → **Finish**. | deferred-join drops the AP, the box joins home Wi-Fi and comes online (the reach-me QR/link shows on the complete step **if** the off-LAN relay was provisioned — a separate, billable `infra/relay-poc/provision-box.sh` step) |
| 4b | Phone / laptop | **Show the product:** open the dashboard (`:9200`) — the approval queue is **already populated** (seeded in step 3). Open a pending draft, edit it, approve it. | demonstrates real triage → draft → approve without waiting on live Gmail |
| 5 | Re-demo | `~/AgentBOX/install/demo-reset.sh --seed-demo --reboot` → back to step 4 | fresh wizard + fresh seeded queue |

`--seed-demo` is optional: drop it to show a genuinely empty first-run (no demo data). It only inserts sample rows; it never touches live Gmail.

## Scenario B — box already provisioned (the common re-demo)

Skip steps 1–2.

1. **On the box:** `~/AgentBOX/install/demo-reset.sh --seed-demo --reboot`
   *(add `--wipe-mail-data` for a truly clean slate that also clears prior emails/drafts/RAG)*
2. **Phone:** same as Scenario A, steps 4 + 4b.

---

## Config — the GitHub token step 2 needs

The on-box install (`onboarding-test-setup.sh`) clones a **private** repo and builds against
private packages, so it needs a GitHub PAT with two scopes (one PAT carrying **both** works —
pass it as `AB_GH_TOKEN`):

| Scope | Why |
|-------|-----|
| **`repo`** | clones the PRIVATE `agentbox-sidecar` (the `:9200` UI) |
| **`read:packages`** | the dashboard build pulls private `@umb-advisors/*` from npm.pkg.github.com; a `repo`-only token 401/403s (the installer preflights this and fails fast) |

Branch: clone `main` for the merged base, or a feature branch (e.g. `demo/agentbox`) for the
newest OOBE work. `install/agentbox-install.sh` (base appliance) also takes `--prototype`
(throwaway secrets, no Caddy) vs production (1Password).

> The old host-driven flash's `provision.env` (`BOARD_CONFIG`, `BOX_USER`, `BSP_DIR`, …) is
> **not used** in this flow — those only apply to the advanced `/agentbox-flash` path.

---

## The reset/teardown script family (pick the right one)

| Script (on the box) | Use when | Keeps the stack? |
|---------------------|----------|------------------|
| `install/demo-reset.sh` | **Re-demo**: reset to fresh OOBE, keep the box working | ✅ (dev access + stack + models preserved) |
| `install/onboarding-test-reset.sh` | Only re-arm the AP; keep connected accounts | ✅ |
| `install/onboarding-test-teardown.sh` | Re-test the installer from scratch (strips the sidecar + toolchain) | ❌ (heavy dev teardown) |

`demo-reset.sh` is safe-by-default: `--dry-run` previews everything, a `type RESET`
confirm guards a real run (`--yes` to skip), and it refuses on a known production
host (`DEMO_RESET_ALLOW_PROD=1` to override). It is **not** a customer-ship
sanitizer — it preserves SSH, `BOX_PASS`, sudoers, Tailscale, and the git remote.

## Notes

- These instructions clone the monorepo to **`~/AgentBOX`** (step 2), so the scripts live
  under `~/AgentBOX/install/`. `onboarding-test-setup.sh` self-locates the repo, so a
  different clone path works too — just adjust the `~/AgentBOX/...` paths above to match.
- The sidecar serves the **compiled** `web/dist`, so a `git pull` alone never updates the
  UI on the box — rebuild after pulling: `~/agentbox-sidecar/bin/update-ui.sh` (pull → build
  → restart), or `pnpm build` in `agentbox-sidecar/web` + restart `agentbox-sidecar`.
