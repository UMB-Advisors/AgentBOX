# Out-of-Box Onboarding — Gap Analysis & Implementation Status (v0.1.0)

**Goal:** a customer buys an AgentBOX, powers it on, and uses **only their phone** to
fully set it up — join WiFi, reach "live" — no monitor/keyboard/laptop.

**Method:** a 9-agent expert+research fleet surveyed both repos
(`AgentBOX` monorepo + `agentbox-sidecar`) and synthesized a prioritized plan (2026-06-28).
This doc records the findings and tracks what's been implemented since.

**Verdict at survey time:** phone-only OOBE was well-designed and ~50% built; the
wireless-only happy path did **not** work end to end. The system AP layer + the stage
machine + mail-connect worked; the journey broke at: (1) sidecar unreachable from the AP,
(2) no WiFi step / no network API, (3) mode-B reconnect stranded the phone, (4) the AP never
self-disabled.

---

## Decisions taken (fleet recommendations, all reversible)

- **G7 AP auth = open AP for v1.** A random WPA2 PSK is unreadable to a phone that hasn't
  joined (chicken-and-egg). Set via `AGENTBOX_AP_OPEN=1` in the service unit; flip to WPA2
  once a serial-derived PSK is printed/QR'd on the box (Phase 4).
- **G9 stage shape = orthogonal `network_configured` flag**, not a new stage. Keeps the
  `pending_admin→…→live` chain and already-networked boxes backward-compatible.
- **G8 discovery = mDNS (`agentbox.local`) primary + Tailscale fallback** for mode-B reconnect
  (UX wired; provisioning/E2E still pending — see below).

---

## Gap status

| ID | Gap | Sev | Status |
|----|-----|-----|--------|
| G1 | No `/api/network/*` backend (scan/join/status) | blocker | ✅ **done** — `features/network.py`, registered in `app.py` |
| G2 | Sidecar binds loopback at AP boot (wizard unreachable) | blocker | ✅ **done** — AP writes `onboarding.env` (SIDECAR_HOST=0.0.0.0); service sources it; healthcheck |
| G3 | Sidecar never writes `onboarding-complete` (AP never self-disables) | blocker | ✅ **done** — `set_stage('live')` writes the marker + clears env; install makes the dir writable |
| G4 | No connect-network wizard step | blocker | ✅ **done** — `ConnectNetworkBody` + step descriptor + status gating |
| G9 | Stage-machine composition for the network step | major | ✅ **done** — `network_configured` flag |
| G7 | AP auth model undecided | major | ✅ **decided+set** — open AP v1 (`AGENTBOX_AP_OPEN=1`) |
| G5 | Mode-B reconnect handoff + discovery | blocker | ✅ **code-complete** — reconnect panel links to the box's real `<hostname>.local` + best-effort poll; **AP now comes up only when offline** (guard), so no ethernet crutch and no remote-box bricking. Needs hardware E2E (G16) |
| G8 | Discovery (mDNS) | major | ✅ **done** — `avahi-daemon` installed/enabled at install; status API returns `hostname`; wizard links to `<hostname>.local:9200` |
| G6 | Mobile spine + focus-shell merge | major | 🟡 consolidated onto `feat/onboarding-oobe`; focus-shell wiring still per the mobile-focus handoff |
| G10 | Onboarding/network routes ungated | major | ⬜ **todo** — production hardening (`ONBOARDING_API_TOKEN` + header check); low risk given short window |
| G11 | Crypto key (`HERMES_MAIL_SECRET_KEY`) unconfigured blocks email-connect | major | ⬜ **todo** — generate at install (monorepo) |
| G12 | Installer doesn't install/enable the sidecar | major | ⬜ **todo** — a clean-flashed box has no wizard to serve without manual steps; **important for true OOBE** |
| G13 | No skip-email escape hatch on probe failure | minor | ⬜ todo (partial skip exists on the mobile branch) |
| G14 | Gmail OAuth not in phone wizard | minor | ⬜ by design — IMAP app-password path works; native OAuth later |
| G15 | No captive-portal auto-launch | minor | ⬜ Phase-4 polish (dnsmasq DNS hijack + `/generate_204`·`/hotspot-detect.html`) |
| G16 | Mode-B never tested end-to-end on real hardware + phone | minor | ⬜ **todo — the verification gate** for G5 |

---

## What works now (the wireless happy path, mode A — ethernet present)

Power on → AP up → phone joins (open) → wizard reachable at `10.42.0.1:9200` → welcome →
**connect-network (scan/pick/join)** → online → email-connect (M365/IMAP) → live →
`onboarding-complete` written → AP self-disables next boot. Implemented and code-verified
(tsc + py_compile + `bash -n`); **not yet hardware-verified**.

## The remaining critical path to "fully works on any box"

The wireless mode-B path is now **code-complete** (AP only when offline → join → AP drops →
phone reconnects to home WiFi → `<hostname>.local:9200` resumes the wizard). What's left:

1. **G16 hardware E2E for mode B** — THE verification gate; needs a real offline box + iOS and
   Android phones. Until this runs, mode B is "should work," not "proven."
2. **G12** — installer must clone+enable the sidecar so a freshly flashed box actually serves
   the wizard.
3. **G11** — auto-generate `HERMES_MAIL_SECRET_KEY` at install so email-connect never hard-blocks.
4. **G10** — gate the onboarding/network routes before production.
5. **G15** — captive-portal auto-launch (so the customer doesn't type `…/onboarding`).

---

## Branches (all committed locally; nothing pushed — `DaemonAeon` is read-only on the org)

- monorepo `feat/onboarding-wifi-ap`: design doc, AP script/service, install STAGE 0.3, G2/G3/G7.
- sidecar `feat/onboarding-oobe`: mobile wizard (4 commits) + bind config + network API (G1/G3/G9)
  + connect-network step (G4). Integration branch built on `feat/onboarding-mobile-focus`.
