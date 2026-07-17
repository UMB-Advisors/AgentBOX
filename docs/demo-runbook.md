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
| 1 | Operator host | Extract the Jetson Linux BSP (set `BSP_DIR`), `apt install sshpass`, put the Jetson in **recovery mode** (jumper). Copy `.claude/skills/agentbox-flash/provision.env.example` → `provision.env` and fill it (see **Config** below). The box must reach the **internet** after first boot (LAN / Ethernet with DHCP). | config ready |
| 2 | Operator host | Run the flash: the **`/agentbox-flash`** skill, or `bash .claude/skills/agentbox-flash/provision-jetson.sh`. *Optional:* prefix `WITH_RELAY=1` for off-LAN "reach from anywhere" (**billable** — stands up a Railway service; needs `railway login` on this host). | flash → install → sidecar; **green `:9200`, box online on your LAN** (not yet in AP mode) |
| 3 | On the box | `~/agentbox/install/demo-reset.sh --seed-demo --reboot` (run once with `--dry-run` first to preview) | clears onboarding + connected accounts, **seeds a demo inbox**, takes Wi-Fi offline, reboots → ~90 s later broadcasts **`AgentBOX-Setup-XXXX`** |
| 4 | Phone | Join `AgentBOX-Setup-XXXX` (open, no password). Open **`http://10.42.0.1:9200/onboarding`**. Walk the wizard → **Finish**. | deferred-join drops the AP, the box joins home Wi-Fi and comes online (the reach-me QR/link shows on the complete step **if** the relay was provisioned in step 2) |
| 4b | Phone / laptop | **Show the product:** open the dashboard (`:9200`) — the approval queue is **already populated** (seeded in step 3). Open a pending draft, edit it, approve it. | demonstrates real triage → draft → approve without waiting on live Gmail |
| 5 | Re-demo | `~/agentbox/install/demo-reset.sh --seed-demo --reboot` → back to step 4 | fresh wizard + fresh seeded queue |

`--seed-demo` is optional: drop it to show a genuinely empty first-run (no demo data). It only inserts sample rows; it never touches live Gmail.

## Scenario B — box already provisioned (the common re-demo)

Skip steps 1–2.

1. **On the box:** `~/agentbox/install/demo-reset.sh --seed-demo --reboot`
   *(add `--wipe-mail-data` for a truly clean slate that also clears prior emails/drafts/RAG)*
2. **Phone:** same as Scenario A, steps 4 + 4b.

---

## Config — `provision.env` (the fields that matter)

| Field | Value | Notes |
|-------|-------|-------|
| `BOARD_CONFIG` | `jetson-orin-nano-devkit-super` | `...-devkit` on older JetPack. Wrong value = failed flash. |
| `BOX_USER` / `BOX_PASS` | your headless account | baked into the rootfs |
| `GIT_TOKEN` | PAT, scope **`repo`** | clones the PRIVATE `agentbox-sidecar` (the `:9200` UI) |
| `GITHUB_PACKAGES_TOKEN` | PAT, scope **`read:packages`** | the dashboard build pulls private `@umb-advisors/*`; a `repo`-only token 401/403s (the installer preflights this and fails fast) |
| `AGENTBOX_GIT_REF` | `demo/agentbox` | the OOBE superset (until it merges to `main`) |
| `INSTALL_MODE` | `--prototype` | throwaway secrets, no Caddy (bench); production uses 1Password |

One PAT carrying **both** `repo` and `read:packages` can serve as both tokens.

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

- On the box the monorepo is cloned at lowercase **`~/agentbox`** (the flash's
  `BOX_CHECKOUT` default), so the scripts live under `~/agentbox/install/`.
- The box clones from `origin/demo/agentbox`; make sure that branch carries these
  scripts (this doc + `demo-reset.sh` ride PR #119). If you provisioned before they
  landed, `git -C ~/agentbox pull` on the box.
