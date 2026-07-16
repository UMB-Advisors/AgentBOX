# AgentBOX — Engineering Handoff

*Written as a full handoff for the next engineer or agent. Nothing assumed; read top to
bottom once, then use as a reference. Last updated 2026-07-06.*

> **Orientation in one paragraph.** AgentBOX is an edge-AI appliance on an NVIDIA Jetson
> Orin Nano Super (8GB) that co-hosts an email pipeline (**MailBOX**), an agent (**Hermes**),
> and a memory layer (**gBrain**). The user-facing front door is the **agentbox-sidecar**
> (FastAPI on `:9200`), which transparently reverse-proxies stock Hermes (`:9119`). The most
> active recent work — and the bulk of this handoff — is the **out-of-box onboarding (OOBE)**:
> letting a non-technical customer set up a freshly-flashed box entirely from their phone. That
> work is **feature-complete in code but not merged and not fully hardware-verified.** Details below.

---

## 0. TL;DR for the impatient

- **Two repos**, not one: `UMB-Advisors/AgentBOX` (monorepo: system/provisioning/install) and
  `UMB-Advisors/agentbox-sidecar` (the operator UI + FastAPI backend). Custom features live in
  the **sidecar**, never in stock Hermes.
- **The OOBE work is on feature branches, NOT `main`:** monorepo `feat/onboarding-wifi-ap`,
  sidecar `feat/onboarding-oobe`. Nothing is deployed to production; it's been tested on one
  bench box (`agentboxhonduras`).
  > **⚠️ SUPERSEDED (2026-07-15):** the monorepo integration branch is now **`demo/agentbox`**
  > (the superset carrying `infra/relay-poc/` + the flash fixes). PR #117 already merged the base
  > OOBE stack to `main`; PR #118 carries the newest flash fixes. **Do NOT reset the monorepo to
  > `feat/onboarding-wifi-ap`** — that branch predates and **wipes `infra/relay-poc/`** (the
  > reach-me code). Treat monorepo branch references below as `demo/agentbox`. The sidecar branch
  > (`feat/onboarding-oobe`) is unchanged.
- **Architecture that landed:** *deferred-join* — the box hosts a WiFi setup AP the whole
  wizard; WiFi + mailbox are **saved** while offline; on "Finish" the box joins WiFi and connects
  the mailbox itself. No reconnect, no mDNS dependency, phone-only.
- **Biggest open risks:** (1) the post-online mailbox connect (the detached finalizer) is
  **not yet witnessed on hardware**; (2) **post-onboarding dashboard reachability is unsolved**
  (mDNS blocked on real routers) — the chosen fix is a branded cloud URL, deferred; (3) a
  **Tailscale fleet lateral-movement risk** if a box is stolen — likely wide open, unaudited.
- **Toolchain landmines** (all solved, don't re-suffer): Jetson ships Node 18 but Vite 7 needs
  ≥20.19 → install Node 22; pnpm 10/11 gate esbuild's native-binary build → pin **pnpm 9**.

---

## 1. What this is, and the mental model

AgentBOX absorbs the MailBOX stack (decision 2026-06-06). The layering, front to back:

```
  phone / laptop / operator
        │  (HTTPS via Cloudflare tunnel :9120 → :9200, or LAN, or the setup AP at 10.42.0.1)
        ▼
  agentbox-sidecar  ── FastAPI :9200 ──  THE FRONT DOOR
        │  - serves the vendored SPA (web/dist) at /
        │  - local /api/* feature routers (onboarding, network, mail, graph, tasks, …)
        │  - transparently reverse-proxies everything else to stock Hermes
        ▼
  stock Hermes  :9119   (agent + gateway; upstream v0.16.0, minimally patched)
        │
        ▼
  MailBOX pipeline (docker): postgres, qdrant, ollama, n8n, mailbox-dashboard :3001
  gBrain (memory layer)
```

**Rule that overrides instinct:** never add features to Hermes' `web_server.py`/`hermes_cli`.
Custom features go in the **sidecar** (`agentbox-sidecar/src/agentbox_sidecar/features/*`) or
`~/.hermes/plugins`. The stale vendored `hermes-agent-main/` tree was removed (MBOX-492); recover
from git history or `UMB-Advisors/agentbox-hermes-patches` if ever needed.

**Two "dashboards" — do not confuse (MBOX-469):** the vendored `mailbox/dashboard/` (Next.js,
`:3001`) is the **headless MailBox pipeline backend** behind the Hermes proxy — its UI is retired
but the service is load-bearing (n8n workflows hit ~33 of its `/api/internal/*` routes; don't
rename the docker service). The *operator* dashboard is the sidecar SPA.

---

## 2. The fleet (physical topology)

All units are Jetson Orin Nano Super. **Probed uniform hardware (2026-06):** Realtek **RTL8822CE**
WiFi on the out-of-tree `rtl8822ce` driver — **AP mode works, but AP+STA concurrency does NOT**
(`iw phy`: "interface combinations are not supported"). This single fact shaped the entire OOBE
design. Every unit also has an `enP8p1s0` ethernet port.

| Unit | Reach | User | Notes |
|---|---|---|---|
| `agentbox1` (host `dustin`) | Tailscale `100.120.102.45` | `mailbox` | ethernet up; possibly pre-sidecar divergent arch |
| `agentbox2` | Tailscale `100.127.2.54` | `UMB` | JP7.2 unified build; the sidecar reference box |
| `agentbox3` | Tailscale `100.64.249.7` | *unknown* | **Tailscale SSH disabled** — couldn't log in; historically has drifted |
| `agentboxhonduras` (host `carlos`) | Tailscale `100.117.25.5` | `carlos` | the **OOBE bench box**; WiFi-only (ethernet down); physically with the operator |

**SSH gotchas learned the hard way:**
- Tailscale SSH may demand an interactive identity re-check (browser approval) on first use.
- Reflashed boxes change host keys → `Host key verification failed`; fix with `ssh-keygen -R <ip>`.
- `sudo` over a non-interactive SSH session **fails** (needs a password/tty). Anything privileged
  must run in the operator's own terminal, or via a NOPASSWD sudoers rule.
- **The AP path severs remote access.** When a box brings up the setup AP, its single radio leaves
  client mode → WiFi/Tailscale drop → you lose SSH. **Never trigger onboarding on a remote-only box
  you can't physically reach** (this nearly bricked the Honduras box repeatedly).

---

## 3. Repositories, branches, and what's where

### 3.1 `UMB-Advisors/AgentBOX` (monorepo — system/provisioning/install)
- `install/agentbox-install.sh` — canonical staged fresh-box bring-up. STAGE 0.2 = Tailscale SSH;
  **STAGE 0.3 (new) = onboarding AP** (installs the AP unit + sudoers + avahi + writable state dir).
- `install/onboarding-test-{setup,reset,teardown}.sh` — the OOBE test harness (see §6).
- `provisioning/35-onboarding-ap.{sh,service}` — the setup-AP bring-up logic + systemd unit.
- `provisioning/*.sh` — numbered staged provisioning steps (base, inference, agent, gbrain, kiosk,
  hardening…).
- `docs/` — PRDs, STATE files, and the OOBE design docs (§4).
- `mailbox/` — vendored MailBOX stack (compose, dashboard, n8n). `gbrain-master/` — vendored gBrain.
- **`web_dist` is a gitignored build artifact — never committed.**

### 3.2 `UMB-Advisors/agentbox-sidecar` (the app)
- `src/agentbox_sidecar/app.py` — FastAPI app; registers feature routers *before* the catch-all
  Hermes proxy (order matters — local routes must shadow the proxy).
- `src/agentbox_sidecar/features/*.py` — one module per domain. OOBE-relevant: `onboarding.py`
  (stage machine + pending-mailbox store), `network.py` (WiFi scan/save/apply), `mail_accounts.py`
  (`connect_graph`/`connect_imap` — probe→persist), `token_crypto.py` (AES-GCM at-rest secrets),
  `static_ui.py` (serves `web/dist`, proxies misses to Hermes).
- `web/` — Vite 7 + React 19 SPA. Built to `web/dist` (gitignored). The onboarding wizard is
  `web/src/pages/OnboardingPage.tsx`; shared mail forms `web/src/components/MailConnectForms.tsx`;
  wizard helpers `web/src/lib/onboardingWizard.ts`; API client `web/src/lib/api.ts`.
- `deploy/agentbox-sidecar.service` — the systemd **user** unit (runs via `uv run uvicorn …`).

### 3.3 Branch state (CRITICAL — nothing is merged)

| Repo | Branch | Base | Status |
|---|---|---|---|
| monorepo | `feat/onboarding-wifi-ap` | `main` | ✅ pushed; **not merged** |
| sidecar | `feat/onboarding-oobe` | `main` (`0a6bfa0`) | ✅ pushed; **not merged**; the integration branch |
| sidecar | `feat/onboarding-mobile-focus` | `0a6bfa0` | merged *into* `feat/onboarding-oobe` |
| sidecar | `feat/onboarding-ap-bind` | `main` | merged *into* `feat/onboarding-oobe` |

`feat/onboarding-oobe` is the branch that matters — it contains the mobile wizard + the bind change
+ the full deferred-join build. When you're ready, that's what merges to sidecar `main`, and
`feat/onboarding-wifi-ap` merges to monorepo `main`. **They must ship together** (the sidecar reads
state the monorepo AP script writes, and vice-versa).

---

## 4. The OOBE onboarding — the main event

### 4.1 The goal
A customer buys a box, powers it on, and sets it up **entirely from a phone** — no laptop, no shell,
no router config, no app install. End state: box on their WiFi and **triaging their email**.

### 4.2 The core problem and the design that solved it
The single WiFi radio can't be an access point *and* a client at once (RTL8822CE, no concurrency).
Early designs tried a "reconnect dance" (box drops the AP to join WiFi, phone reconnects and re-finds
the box via mDNS). **That failed on real routers — mDNS/`.local` was blocked** — and Tailscale/dual-radio
were rejected (not viable for end users / no hardware change). 

The design that stuck is **deferred-join**: the box stays on its setup AP for the *entire* wizard;
nothing about the radio changes mid-flow. Everything is *collected* while offline and *applied* as the
very last action, when the customer is already done and has nothing left to reach.

**Wizard spine:** `welcome → connect-network → connect-mailbox → complete`
1. **connect-network** — scan (from a pre-AP cache; see below), pick network, enter passphrase →
   `POST /api/network/save` creates an autoconnect NetworkManager profile **without activating it**
   (AP stays up). Manual SSID entry is available for hidden networks.
2. **connect-mailbox** — `MailConnectForms` in a new **`onDefer` (no-probe) mode**: collects IMAP or
   Microsoft-365 creds *without* a live probe (the box is offline) → `POST /api/onboarding/pending-mailbox`
   stores them **encrypted** (`token_crypto`, AES-GCM, key = `HERMES_MAIL_SECRET_KEY`).
3. **complete → "Finish & go online"** — marks onboarding `live` (writes the `onboarding-complete`
   marker, clears the bind override), then `POST /api/network/apply` kicks a **detached finalizer**
   (`network.py:_finalize_online`) that: joins the saved WiFi (AP drops → response never reaches the
   phone, by design), waits for internet, then connects + verifies the pending mailbox via
   `connect_graph`/`connect_imap` and records it. Survives the AP drop because it's an `asyncio` task
   held in a module-level set, and the sidecar process keeps running.

### 4.3 System-layer mechanics (monorepo `provisioning/35-onboarding-ap.sh`)
- **AP only when offline.** A `has_internet()` guard means the AP fires *only* if the box has no
  uplink. This is both correct (no need for an AP when already online) and a **safety guard** (it can't
  knock an already-online box off its network).
- **Pre-AP scan cache.** A single radio can't scan while hosting the AP, so the script scans *before*
  bringing the AP up and writes `/var/lib/agentbox/wifi-scan.cache`; `network.py` serves the picker from
  it. Without this the picker only ever saw the AP's own beacon.
- **Bind flip.** The sidecar defaults to `SIDECAR_HOST=127.0.0.1`; the AP script writes
  `/var/lib/agentbox/onboarding.env` (`SIDECAR_HOST=0.0.0.0`, sourced by the user unit) so the wizard is
  reachable at `10.42.0.1:9200`. Cleared at `stage=live`.
- **nmcli privilege.** The sidecar is a non-root lingering user service; NetworkManager denies it
  `nmcli … connect` ("Insufficient privileges"). A NOPASSWD sudoers rule
  (`/etc/sudoers.d/agentbox-onboarding-nmcli`) grants the box user `nmcli`; `network.py` calls the
  connect/apply paths with `sudo -n`.
- **AP auth (decision G7):** open AP for v1 (`AGENTBOX_AP_OPEN=1`). A random WPA2 PSK is unreadable to a
  phone that hasn't joined yet. Label/QR-printed WPA2 is a Phase-4 hardening item.
- **Self-disable.** The unit has `ConditionPathExists=!/var/lib/agentbox/onboarding-complete`; once the
  sidecar writes that marker at `stage=live`, the AP never comes back.

### 4.4 Where to read more
- `docs/onboarding-wifi-ap-provisioning.v0.1.0.md` — the system-layer design + the P0 hardware probe.
- `docs/onboarding-oobe-gap-analysis.v0.1.0.md` — a **9-agent fleet survey** that produced the
  authoritative gap list (G1–G16) with per-gap status. **Read this second; it's the map of what's done
  vs. open.**
- `docs/onboarding-wizard-design.v0.1.0.md` — the earlier wizard design (pre-OOBE).

---

## 5. Build & toolchain — hard-won, do not re-suffer

Every one of these cost real time. The setup script already handles them; this is so you understand
*why* it does what it does.

- **Node:** Jetson `apt` ships Node **18**, but **Vite 7 dropped Node 18** (needs ≥20.19). The setup
  script installs **Node 22 via NodeSource**. Symptom if wrong: `crypto.hash is not a function` /
  engine-unsupported during build.
- **pnpm:** pnpm **10/11 gate dependency build scripts** by default — esbuild's postinstall (which
  fetches its native binary) is skipped, so `vite build` fails; and pnpm 11 *exits non-zero* on the
  "ignored builds" reminder, which killed the `set -e` setup script before it could recover. Also pnpm 11
  no longer reads `pnpm.onlyBuiltDependencies` from `package.json` (it moved to `pnpm-workspace.yaml`,
  which in turn breaks pnpm 9 with "packages field missing or empty"). **The escape: pin pnpm 9** — it
  runs build scripts by default, no gate. The setup script force-clears any corepack/npm pnpm shims and
  installs `pnpm@9`. Don't reintroduce a `pnpm-workspace.yaml` with a bare `onlyBuiltDependencies`.
- **The web is built off-box** conceptually, but the setup script installs Node on the box and builds
  there (the box only needs Python/`uv` to *run* the sidecar; Node is only for the *build*).
- **`uv`** runs the Python backend (`uv sync`, `uv run uvicorn`). Installed via the astral script.
- **Crypto key:** the pending mailbox is stored encrypted, so `HERMES_MAIL_SECRET_KEY` (32-byte hex)
  must exist in `~/.hermes/.env`. The setup script generates it if absent (`openssl rand -hex 32`).

---

## 6. Testing the OOBE (the scripts, and the constraints)

Three scripts in monorepo `install/`, all run **on the box**:

- **`onboarding-test-setup.sh`** — the one-shot. Self-updates both repos (`git fetch`+`reset --hard`
  to the branch tips), clones the sidecar if missing (`AB_GH_TOKEN=<token>` for the private repo),
  installs Node 22 / pnpm 9 / uv, builds `web/dist`, `uv sync`, generates the crypto key, installs the
  AP unit + sudoers, starts the sidecar, clears state, disables WiFi autoconnect, and **reboots into AP
  mode**. Prompts for `sudo` once. Dies with a specific `ERROR:` line if any real step fails.
- **`onboarding-test-reset.sh`** — clear onboarding state + saved profile + disable autoconnect so the
  AP fires again on next boot (keeps the toolchain/build).
- **`onboarding-test-teardown.sh`** — "simulate a fresh flash": wipe the AP unit, sidecar service,
  sudoers, state dir, NM profiles, avahi, and the Node/pnpm/uv toolchain + sidecar clone. Keeps the
  monorepo clone. Use this to validate the setup script truly from scratch.

**The test IS the end-user experience:** after setup reboots, on a phone → join `AgentBOX-Setup-XXXX`
(open) → `http://10.42.0.1:9200/onboarding` → pick WiFi → enter mailbox → Finish.

**What is verified vs. not (be honest with yourself here):**
- ✅ On hardware: the full toolchain builds, the sidecar serves, all `/api/onboarding/*` +
  `/api/network/*` routes are live, the wizard renders, and the **network-only** happy path (join WiFi →
  online) worked end-to-end.
- ⚠️ **NOT yet witnessed on hardware:** the detached finalizer actually joining WiFi *and* connecting the
  saved mailbox after the AP drops — it can't be exercised over SSH (needs the real radio switch + a live
  mailbox). This is the #1 thing to confirm on the next real run. Trace it with
  `journalctl --user -u agentbox-sidecar -b | grep -i "apply:"`.

---

## 7. Deploy / release

- **This monorepo no longer deploys the dashboard** (MBOX-492). `bin/deploy-dashboard.sh` and the CI
  deploy workflow were removed. Custom-feature deploys happen from the **agentbox-sidecar** repo per its
  `docs/update-runbook.md` (`pnpm build` → rsync to the box → restart the user unit).
- **Historical lesson worth keeping:** multiple agents share one appliance per box; concurrent
  `rsync --delete` deploys raced and clobbered each other. The rule that survived: *one deployer, always
  from up-to-date `origin/main`.* Worktree isolation does **not** protect a shared box.
- **GitHub access:** the machine authenticates as **`DaemonAeon`**. It was initially read-only on the
  `UMB-Advisors` org (pushes 403'd); it now has write. If pushes fail with "could not read Username" set
  the credential helper with `gh auth setup-git`. Push only when asked; branch off `main` first.
- **Nothing OOBE is on `main` or deployed.** Releasing = merge both feature branches together, then run
  the sidecar update-runbook on each box (or reflash — see below).

### 7.1 Flashing a fresh box
The `agentbox-flash` skill drives bare-hardware → green box: detect the board in recovery mode, flash
Jetson Linux to NVMe, reach the box over USB device-mode networking, host prep, clone the monorepo, run
`agentbox-install.sh`. It stops cleanly at the three human-only steps: the recovery-mode jumper, Gmail
OAuth consent, and 1Password unlock. A real fresh flash *has the monorepo cloned* — which is why the OOBE
setup script assumes the monorepo present and clones only the sidecar.

---

## 8. Security posture — read before you ship

- **Fleet lateral movement (UNRESOLVED, high priority).** All boxes are on one Tailscale tailnet with
  Tailscale SSH enabled by default. **If the tailnet ACL is the default (allow-all node-to-node) — and
  nothing indicates it was locked down — a physically stolen box can reach every other AgentBOX's services
  worldwide.** The ACL could not be audited from the dev machine (it lives in the Tailscale admin console).
  **Action for whoever owns security:** audit the ACL; add tag-based isolation so `tag:agentbox` nodes
  reach only the control plane, not each other; enable tailnet lock; restrict box→box SSH; and on theft,
  revoke the node immediately.
- **Ungated sidecar API (gap G10).** The Hermes session gate was dropped when routes were ported to the
  sidecar ("binds loopback only" was the assumption). But onboarding sets `SIDECAR_HOST=0.0.0.0` during
  setup, so `/api/onboarding/*` and `/api/network/*` are reachable *unauthenticated* on the open AP (and,
  combined with the item above, potentially over the tailnet). Close G10 (an `ONBOARDING_API_TOKEN` header
  check) before production.
- **At-rest secrets:** mailbox creds are AES-GCM encrypted with `HERMES_MAIL_SECRET_KEY`, which lives in
  `~/.hermes/.env` **on the box**. Physical possession of a box = that box's mailbox creds are recoverable.
  That's inherent to on-device storage; note it for the threat model.
- **Open setup AP:** v1 ships an open (no-password) AP. The exposure window is the setup period; the
  admin gate + short window are the only current protection. WPA2-with-printed-PSK is the hardening path.

---

## 9. Open work / TODO (prioritized)

1. **Witness the mailbox finalizer on hardware** (§6) — the one unproven path. Highest priority; it's the
   difference between "network onboarding works" and "fully operational from phone works."
2. **Post-onboarding dashboard reachability** — mDNS is blocked on real routers; there is currently **no
   clean phone-only way to reach the dashboard after the box is online.** Decision made: build a **branded
   cloud URL** (proxying to the box, e.g. via Tailscale) — tracked as **MBOX-451**, deferred. Until then,
   a non-technical customer cannot re-open the dashboard. This is a real product gap.
3. **Close G10** (gate the onboarding/network routes).
4. **G12** — the installer doesn't clone/enable the sidecar; a fresh flash gets the AP unit but no wizard
   to serve without manual steps. Fold the sidecar install into `agentbox-install.sh`.
5. **Merge the two feature branches** to their mains (together), then deploy/reflash the fleet.
6. **Audit + lock down the Tailscale ACL** (§8).
7. **agentbox3** — re-enable Tailscale SSH and confirm its WiFi hardware matches the fleet.
8. **Captive-portal auto-launch (G15)** so the customer doesn't have to type `10.42.0.1:9200/onboarding`.
9. **WPA2 label/QR AP auth (G7 Phase-4)**.

---

## 10. Tooling for future agents (installed this session)

- **`/goal`** (`~/.claude/skills/goal/`) — a closed-loop "run-until-verified" controller: give it a
  *measurable* end-state and it loops work→sense→brake until an independent sensor confirms it. Refuses
  taste/judgment goals. Use for "keep going until tsc + this E2E check pass."
- **`/supergoal`** (`~/.claude/skills/supergoal/`) — plans a big task into verifiable phases, one human
  plan-review gate, then hands off a single `/goal` that executes all phases with retry + audit.
  **Depends on `/goal`.** Use as the front door for ambitious multi-phase builds (this OOBE work is
  exactly its sweet spot — it would have imposed the structure this build lacked).
- **`~/.claude/rules/*.md`** (`safety`, `context-hygiene`, `agent-routing`, `verifier-protocol`) — these
  were **reconstructed** (the originals weren't shipped with the skills), faithful to what the skills
  assert but with a **placeholder agent roster** (CompliantImplementer/PostgresDBA/Delphi/Metrc/… from the
  skills' origin environment) that falls back to `general-purpose`/`Explore`. If you have your own
  specialist subagents, edit `agent-routing.md` to map to them.

---

## 11. Conventions & landmines (the "trivial" things that aren't)

- **Linear:** file issues in the **staqs / AgentBOX** project via the `linear-staqs` MCP (NOT
  `linear-server`). Issues are `MBOX-*`. The old UMB-Advisors AgentBOX project is canceled.
- **`bash -n` is the monorepo's "test"** for install/provisioning scripts — must pass before commit.
- **Commit trailer:** end commit messages with the project's `Co-Authored-By` line.
- **Frontend checks:** `pnpm exec tsc -b` must be clean; `pnpm exec eslint …` has **~15 pre-existing
  problems on the base** (a `void load()` set-state-in-effect among them) — your changes should add
  **zero** new ones. Don't be alarmed by the baseline count.
- **The nous `Button` component** ships `leading-0` + `tracking-[0.2em]` `font-mono`. Long labels collapse
  onto themselves and render garbled. Fix pattern (used twice already): `style={{ whiteSpace: "normal",
  lineHeight: 1.25, textAlign: "center" }}` + a short label. If a button looks like mangled overlapping
  text, this is why.
- **Scan-cache freshness:** the WiFi picker is only as current as the pre-AP scan; a network that appears
  after boot won't show until reboot. Manual entry is the escape hatch.
- **Don't run onboarding on a remote-only box** (§2). Don't `sudo` over non-interactive SSH (§2).
- **Memory:** the operator's auto-memory lives at
  `~/.claude/projects/-Users-carlos-Documents-AgentBOX/memory/` with a `MEMORY.md` index; the OOBE state
  is captured in `onboarding-wifi-ap.md` and `onboarding-mobile-focus.md`. Update these as the work moves.

---

## 12. If you do exactly one thing next

Get a box you can **physically touch** into a fresh state (`onboarding-test-teardown.sh` then
`onboarding-test-setup.sh`), run the phone flow through **Finish with a real mailbox**, and confirm from
`journalctl … grep "apply:"` that the finalizer joined WiFi *and* connected the mailbox. That closes the
last unknown in the OOBE story. Everything else in §9 is scheduling and hardening; that one is *truth*.

---

# PART II — ROADMAP: where this is going

*The sections above describe the box as it is. The rest describes the box as it should be, and the path
there. Treat §14 as the actual plan-of-record; §13 is the target it converges to; §16 is the gate that
says "ship."*

## 13. The finalized product — what "done" looks like

### 13.1 North-star customer journey (the experience we're building toward)

This is the whole point. Every roadmap item earns its place by moving one of these steps from "today"
to "target."

| # | Step | Target experience | Today |
|---|---|---|---|
| 1 | Unbox & power on | Box + a printed card (WiFi QR + a short setup URL). Power on, wait ~90s. | Same, minus the card. |
| 2 | Join setup network | Scan the QR → phone joins the box's **WPA2** setup AP automatically. | Open AP, name typed by hand. |
| 3 | Open the wizard | **Captive portal auto-opens** the setup page — no typing an IP. | Must type `10.42.0.1:9200/onboarding`. |
| 4 | Configure | Pick WiFi → enter mailbox → Finish. One screen each, phone-native, localized. | Works (deferred-join); English only. |
| 5 | Go live | Box joins WiFi, connects mailbox, starts triaging. Phone shows "You're set." | Works in code; **finalizer unproven on hardware**. |
| 6 | Confirmation | Customer receives an **email** (to the mailbox they just connected) with their **branded dashboard link**. | None. |
| 7 | Return anytime | Open the **branded URL** from any device, anywhere → dashboard. Stable, no IP/mDNS/VPN. | **No reliable way to reach the dashboard.** |
| 8 | Ongoing (invisible) | OTA updates, health monitoring, and remote support happen without the customer noticing. | Manual per-box; no OTA. |

### 13.2 Engineering definition of done (v1.0, client units)

"Finalized" is not a feeling; it's this list being true:

- **OOBE:** every gap G1–G16 closed. Finalizer proven on real hardware across **iOS + Android** and **≥2
  router types** (incl. one that blocks mDNS). Captive portal, WPA2-label AP, mailbox-in-flow all live.
- **Reachability:** a **branded cloud URL** (MBOX-451) resolves to any box from anywhere, no VPN/mDNS.
- **Security:** Tailscale ACL enforces **per-box isolation** (a stolen box reaches nothing else); tailnet
  lock on; onboarding/network API **gated** (G10 closed); AP is WPA2 not open.
- **Provisioning:** **one flash → a complete, wizard-serving box** — the installer installs+enables the
  sidecar (G12), generates the crypto key, and leaves the box in "ready-to-onboard" state with zero manual
  steps beyond the three human gates in `agentbox-flash`.
- **Operations:** an **OTA update path** exists (a box in the field can be updated safely); a **fleet
  health view** (per-box status, last-seen, pipeline health) exists; a documented **remote-support** and
  **incident/recovery** runbook exists.
- **Codebase:** both onboarding branches **merged to `main`**; CI runs `bash -n` + `tsc` + `eslint`
  (no-new-errors) + a smoke build; a **single-deployer** release path; `web_dist` never committed.
- **Docs:** flash runbook, deploy runbook, support runbook, incident runbook, and this handoff all current.

## 14. Roadmap: current → v1.0 (plan of record)

Six milestones. Each is **independently shippable** and has a **measurable exit criterion** (in the
`/goal` spirit — if you can't write a check that proves it, it isn't done). Ordered by dependency, not
just priority.

### Milestone A — Prove the happy path *(unblocks everything; do first)*
- **Work:** run the OOBE end-to-end on a physically-accessible box with a real mailbox; instrument the
  finalizer; repeat on iOS + Android and on a mDNS-blocking router.
- **Exit:** `journalctl … "apply:"` shows join→online→mailbox-connected on ≥2 phones; the connected mailbox
  appears in the box's mail accounts; a 3-minute wall-clock target met. Closes the ⚠ in §6 and gaps G5/G16.
- **Depends on:** nothing. **This is Milestone Zero — until it passes, the rest is built on a maybe.**

### Milestone B — Reachability & identity (the branded URL)
- **Work:** stand up the **branded cloud URL** (MBOX-451) — a stable per-box hostname that proxies to the
  box (via Tailscale/Funnel or a control-plane relay). Wire step 6 (confirmation email with the link) and
  step 7 (the link opens the dashboard). Keep mDNS/`<hostname>.local` as a LAN fast-path fallback.
- **Exit:** a factory-fresh box, after Finish, is reachable at its branded URL from a phone on cellular
  (not the LAN); the confirmation email arrives with a working link. Closes the §9-#2 product gap.
- **Depends on:** A (a box that gets online + a connected mailbox to email from).

### Milestone C — Security hardening
- **Work:** audit + rewrite the **Tailscale ACL** for tag-based per-box isolation; enable **tailnet lock**;
  restrict box→box SSH; close **G10** (`ONBOARDING_API_TOKEN` on onboarding/network routes); switch the AP
  to **WPA2 with a serial-derived PSK printed/QR'd** on the box (G7 Phase-4); document theft response.
- **Exit:** from one box, you provably **cannot** reach another box's `:9200` or SSH; the onboarding API
  rejects an unauthenticated request; the AP requires the printed key. Closes §8 items + G7/G10.
- **Depends on:** B (branded URL must survive ACL lockdown — the control plane needs an explicit allow).

### Milestone D — Provisioning completeness (one flash → done)
- **Work:** fold the sidecar clone+build+enable into `agentbox-install.sh` (**G12**); add the **captive
  portal** (dnsmasq DNS-hijack + `/generate_204`·`/hotspot-detect.html`, G15); generate the crypto key at
  install; update the `agentbox-flash` skill to leave a box in "ready-to-onboard" state.
- **Exit:** a bare board → `agentbox-flash` → power on → the wizard is reachable and the finalizer works,
  with **no manual step** beyond the flash skill's three human gates. Closes G12/G15.
- **Depends on:** A, C (don't bake in an open AP / ungated API).

### Milestone E — Fleet operations
- **Work:** an **OTA update** mechanism (a field box pulls a signed release + restarts safely, with
  rollback); a **fleet health** view (per-box last-seen, onboarding state, pipeline health, disk/mem);
  wire the existing **canary**/post-deploy checks; a remote-support entry point.
- **Exit:** push an update to a test box remotely and watch it apply + roll back on failure; the fleet view
  shows every box's real status. (New tracking issue — not yet filed.)
- **Depends on:** B (stable reachability), C (safe remote access).

### Milestone F — Merge, CI, release v1.0
- **Work:** merge `feat/onboarding-oobe` + `feat/onboarding-wifi-ap` to their mains **together**; add CI
  (`bash -n`, `tsc -b`, `eslint` no-new, smoke build); establish the single-deployer release path; tag
  `v1.0`; refresh all runbooks; roll the fleet.
- **Exit:** §16 checklist fully green; `main` deploys cleanly to a box via the runbook; the tag exists.
- **Depends on:** A–E.

**Sequencing note:** A is a gate, not a phase — do it now, this week, on the Honduras box. B and C are the
product-defining middle. D makes it repeatable. E makes it operable. F makes it real. Resist merging (F)
before A proves the core, or you'll merge a maybe.

## 15. Beyond v1.0 (longer horizon — capture, don't build yet)

- **Localization / i18n.** The Honduras deployment is Spanish-speaking (the test networks were CLARO,
  `Cuarto 3`, `Alvarez`). The wizard is English-only. Real client units abroad need at least ES; the
  wizard copy should be externalized for translation. *This is closer to a v1 requirement than it looks
  given where boxes are going — reassess its milestone.*
- **White-label per client** — branding, dashboard theme, the setup card/QR, the branded URL domain.
- **Multi-mailbox** onboarding (a customer with several inboxes) and **Gmail in-flow OAuth** (currently
  Gmail is app-password-via-IMAP only; native device-code/QR OAuth is a later enhancement).
- **Onboarding analytics** — where do customers drop off? (privacy-respecting).
- **Automated fleet provisioning** at scale (image once, flash many) and hardware-variant support (if a
  future board ships a WiFi chip that *does* AP+STA, the deferred-join design can relax to a seamless flow —
  keep the code path pluggable).
- **Backup/restore & device replacement** — a customer's box dies; how do they get a new one with the same
  config/mailboxes? Needs a config-escrow story.

## 16. Release-readiness checklist (v1.0 Definition of Done — copy into the release issue)

```
OOBE
[ ] Finalizer proven on hardware: iOS + Android, ≥2 routers (one mDNS-blocking)   (Milestone A / G5,G16)
[ ] Captive portal auto-opens the wizard                                          (D / G15)
[ ] AP is WPA2 with a printed/QR key, not open                                    (C / G7)
[ ] Mailbox connects post-online for both IMAP and M365                           (A)
[ ] Manual SSID entry works for hidden networks                                   (done)
Reachability
[ ] Branded URL reaches a box from off-LAN (cellular)                             (B / MBOX-451)
[ ] Confirmation email with dashboard link arrives after Finish                  (B)
Security
[ ] Tailscale ACL: box cannot reach another box's :9200 or SSH                    (C / §8)
[ ] Tailnet lock enabled                                                          (C)
[ ] Onboarding + network API reject unauthenticated requests                     (C / G10)
Provisioning
[ ] One flash → wizard-serving box, no manual steps beyond flash's 3 gates        (D / G12)
[ ] HERMES_MAIL_SECRET_KEY generated at install                                   (done in test setup; move to installer)
Operations
[ ] OTA update applies to a field box with rollback on failure                    (E)
[ ] Fleet health view shows every box's real status                              (E)
[ ] Support + incident/recovery runbooks written                                 (E/F)
Codebase & release
[ ] feat/onboarding-oobe + feat/onboarding-wifi-ap merged to main (together)      (F)
[ ] CI: bash -n + tsc -b + eslint(no-new) + smoke build                           (F)
[ ] Single-deployer release path documented and used                             (F)
[ ] v1.0 tagged; fleet rolled; HANDOFF.md refreshed                               (F)
```

*Green across the board = shippable to a paying, non-technical customer who never opens a terminal. That is
the bar. Anything less is a demo.*
