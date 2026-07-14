# Onboarding WiFi-AP Provisioning — Design & Plan (v0.1.0)

**Status:** DRAFT / design-only. No code yet. Authored 2026-06-24.
**Owner:** TBD. **Repos touched:** `UMB-Advisors/AgentBOX` (system/provisioning) +
`UMB-Advisors/agentbox-sidecar` (wizard UI + network API).
**Relationship to existing work:** prepends a network-provisioning **phase 0** to the
existing setup wizard. The mobile-first wizard work on `feat/onboarding-mobile-focus`
(sidecar) is upstream of this and unaffected; this adds a step *before* `email-connect`.

---

## TL;DR

Today an AgentBOX must arrive **already on a network** — onboarding begins "after OS +
Tailscale," and the operator reaches the wizard over the Tailscale tunnel (`:9120 → :9200`).
We want a true out-of-box experience: power on a freshly-flashed Jetson with **no network
configured**, have it **broadcast its own WiFi access point**, let the operator join that
AP from a phone, and use the existing wizard to tell the box which WiFi network to join —
*then* continue into email setup.

The entire design hinges on **one hardware fact we have not yet confirmed**: does the
target Jetson have a WiFi radio, and if so, can it run **AP + station (STA) concurrently**?
That single answer picks the uplink model and decides whether the painful "reconnect your
phone" handoff exists at all. **Phase 0 of this plan is a hardware probe; everything after
it branches on the result.** agentbox2 (`100.127.2.54`) was offline at authoring time, so
the probe could not be run.

---

## 1. Current state (what exists, what doesn't)

- **No WiFi / AP / hostapd / hotspot / dnsmasq provisioning anywhere** in `install/`,
  `provisioning/`, `systemd/`, or `config/` (grep-confirmed 2026-06-24). The box's network
  story is entirely: ethernet/DHCP + **Tailscale** (`install/agentbox-install.sh` STAGE 0.2
  enables Tailscale SSH; `nmcli` is present on the box).
- The flash skill (`agentbox-flash`) reaches a bare board over **USB device-mode
  networking** during provisioning — a different mechanism from a WiFi AP, but proof the
  "talk to a not-yet-networked box" pattern already exists in this project.
- The **sidecar** serves the operator UI on `:9200` (systemd `agentbox-sidecar.service`);
  the onboarding wizard lives at `/onboarding` (`web/src/pages/OnboardingPage.tsx`), backed
  by a stage machine in `src/agentbox_sidecar/features/onboarding.py`. Stages today:
  `pending_admin → pending_email → ingesting → live`.
- The wizard assumes connectivity already exists. There is **no** "connect this box to a
  network" step.

**Implication:** this feature is genuinely new and spans both repos — system-level AP
bring-up in the monorepo, plus a new wizard step + network API in the sidecar.

---

## 2. The decisive unknown — hardware probe (Phase 0, BLOCKING)

Run on the reference box (and on agentbox2 once reachable). Branch the whole design on the
output. None of this is destructive.

```bash
# Is there a wifi radio at all, and what's its name?
nmcli -t -f DEVICE,TYPE,STATE device | grep wifi
# AP-mode + concurrency capability (the crux):
iw list | sed -n '/Supported interface modes/,/^$/p'      # look for "* AP"
iw list | sed -n '/valid interface combinations/,/^$/p'   # AP + managed in one combo => concurrent AP+STA
# Is ethernet present as an alternate uplink?
ip -br link | grep -iE 'eth|en'
# Driver / chip (AP support quality varies wildly by driver):
lspci | grep -i net; lsusb | grep -iE 'wireless|wifi|802\.11'; nmcli --version
```

> **Hardware caveat.** The Orin Nano (incl. the "Super" rebrand) devkit ships **without
> onboard WiFi** — it has an M.2 Key-E slot for an optional module (often Intel AX201/8265
> or a Realtek part). So "does WiFi AP even work" is a real, per-unit question, not a given.
> Intel mac80211 parts generally do AP; many Realtek out-of-tree drivers do AP but **not**
> concurrent AP+STA. This is exactly why we probe before designing the handoff.

### P0 RESULT — `agentboxhonduras` (probed 2026-06-25)

| Capability | Finding |
|---|---|
| WiFi radio | Realtek **RTL8822CE** (PCIe), driver **`rtl8822ce`** (out-of-tree; cfg80211-only, not mac80211) |
| AP mode | supported (listed in `iw list` interface modes) |
| **AP + STA concurrent** | **NOT supported** — `iw phy` reports `interface combinations are not supported` |
| In-kernel `rtw88_8822ce` (mac80211; can do AP+STA) | NOT present (`modinfo` miss) |
| Ethernet (`enP8p1s0`) | present but DOWN / NO-CARRIER (unplugged) |
| hostapd / dnsmasq | both installed (dnsmasq 2.90) |
| NetworkManager | 1.46.0 |

**Resolution:** this radio is **AP XOR STA — never both at once**. The seamless gold path
(concurrent AP+STA) is **off the table** with the current driver. Remaining options:
**(A)** ethernet uplink + AP stays up (needs a cable; defeats wireless-only setup), or
**(B)** the single-radio reconnect dance (§4) — the realistic wireless path, weakest UX,
needs mDNS/Tailscale discovery. A third path (rebuild on the in-kernel `rtw88_8822ce`
driver to gain concurrency) is possible but means a kernel-module swap on the Tegra
`6.8.12` kernel with rtw88's own tradeoffs — not a casual change.

**Fleet confirmation (probed 2026-06-25):** the RTL8822CE / no-concurrency finding is
**uniform**, not a one-off:

| Box | WiFi chip | AP mode | AP+STA concurrent | Ethernet (`enP8p1s0`) |
|---|---|---|---|---|
| agentboxhonduras | RTL8822CE | ✓ | ✗ | present, down |
| agentbox1 (`dustin`) | RTL8822CE | ✓ | ✗ | up |
| agentbox2 | RTL8822CE | ✓ | ✗ | up |
| agentbox3 | not probed — Tailscale SSH disabled there, no known user | — | — | — |

All probed units carry the same module and the same `enP8p1s0` ethernet port. Design
against **no concurrency** fleet-wide. (agentbox3 still worth a one-off confirm.)

**Decision (2026-06-25):** uplink model = **A-when-cabled-else-B** — detect ethernet
carrier at AP-bring-up time; if a cable is present keep the AP up with ethernet uplink
(seamless), otherwise fall back to the single-radio reconnect dance (§4).

### Decision table (driven by the probe)

| Probe result | Uplink model | Handoff pain | Recommendation |
|---|---|---|---|
| No AP-capable WiFi radio | — | — | Fall back to **USB device-mode** onboarding (reuse flash-skill path) or **ethernet + QR-to-Tailscale**. WiFi-AP onboarding is off the table for that HW. |
| AP **+ STA concurrent** supported | Keep AP up; box also joins user WiFi as STA for uplink | **None** | **Gold path.** Phone stays on the AP the whole time; box reachable at the AP IP throughout; no reconnect. |
| Ethernet present (AP-only radio) | Internet via ethernet; AP stays up | **None** | Good, *if* ethernet is reliably plugged in. Defeats "set up anywhere wireless," so treat as opportunistic, not primary. |
| Single radio, AP **XOR** STA only | Box drops AP to join user WiFi | **Yes** | "Reconnect dance" (§4). Workable but the worst UX; minimize by detecting & guiding. |

---

## 3. System layer (AgentBOX monorepo)

New provisioning step + systemd unit. Prefer **NetworkManager** (already on the box) over
hand-rolled hostapd — `nmcli` gives us AP + shared-IPv4 + dnsmasq DHCP in one command.

- **AP bring-up:** `nmcli device wifi hotspot ifname <wlan> ssid "AgentBOX-Setup" [password <psk>]`
  → NM creates a `10.42.0.1/24` shared network with built-in DHCP/DNS. Gateway IP =
  `10.42.0.1`.
- **New unit** `agentbox-onboarding-ap.service` (oneshot + path/condition guard): bring the
  hotspot **up** only when **onboarding is not `live`** AND **no working uplink** exists.
  Tear it **down** once the box has an uplink and onboarding completes. Must be idempotent
  and survive reboots mid-setup (mirror `provisioning/reboot-resilience.sh` patterns).
- **Serve the sidecar on the AP IP:** confirm `agentbox-sidecar.service` binds `0.0.0.0:9200`
  (not `127.0.0.1`) so AP clients at `10.42.0.1:9200` reach it. The Tailscale tunnel path is
  unchanged.
- **Captive portal (P4, nice-to-have):** dnsmasq DNS hijack + reply to
  `/generate_204`·`/hotspot-detect.html` so iOS/Android auto-pop the setup page on join.
  OS detection differs; treat as polish, not core.
- **New install stage** in `install/agentbox-install.sh` (e.g. STAGE 0.3, after Tailscale)
  to install the unit + NM AP profile. Keep gated/idempotent like the other stages;
  `bash -n` must pass.

---

## 4. The handoff problem (only if §2 lands on "single radio, AP XOR STA")

One radio can't be both the AP and a client at once, so joining the user's WiFi **drops the
AP** and disconnects the phone. Two ways to handle it:

- **(B) Reconnect dance.** After the join succeeds at the `nmcli` layer, the UI shows:
  *"AgentBOX is joining `<ssid>`. The setup hotspot is turning off — reconnect your phone to
  `<ssid>`, then reopen this page."* Then the box must be **rediscoverable** on the user's
  LAN: ship **avahi/mDNS** (`agentbox.local`) and/or lean on **Tailscale MagicDNS**. The
  page polls for the box's reappearance and resumes the wizard.
- **(C) Box joins, user follows.** Same as B but framed as "follow the box onto your WiFi"
  and resume via Tailscale rather than mDNS. Needs Tailscale up before the AP tears down.

Both require a **discovery story** (mDNS or Tailscale) — flag this as the riskiest UX seam.
If §2 gives us concurrent AP+STA or ethernet, **this section is moot** and the UX is
seamless; that's the strong argument for confirming hardware first.

---

## 5. Sidecar layer (UI + network API)

### 5.1 Backend (FastAPI, new `features/network.py`)

| Endpoint | Does |
|---|---|
| `GET /api/network/scan` | `nmcli -t -f SSID,SIGNAL,SECURITY device wifi list` → `[{ssid, signal, security}]`, deduped/sorted by signal. |
| `POST /api/network/join {ssid, psk}` | `nmcli device wifi connect` on the STA interface; returns a job id / immediate status. **Never log the PSK.** Triggers the handoff per the §2 uplink model. |
| `GET /api/network/status` | `{connected, current_ssid, has_internet, ap_active}` — drives the wizard's progress + handoff polling. |

Wraps `nmcli` via subprocess; reuse the sidecar's existing systemd-command pattern. Honor
the existing onboarding auth gate (`ONBOARDING_API_TOKEN` / admin-password) — the network
API is reachable on the open AP, so it must not be a soft spot.

### 5.2 Wizard (new phase-0 step `connect-network`)

- New step **before** `email-connect`, shown only when reached via the AP / box has no
  uplink (key off `GET /api/network/status`). On an already-networked box (Tailscale path),
  skip it — keeps the `feat/onboarding-mobile-focus` 3-step spine intact for that case.
- UI: scan list (signal + lock icon) → tap network → passphrase field (`inputMode`,
  show/hide) → Join. Then either an instant "Connected ✓" (gold path) or the §4 handoff
  panel with reconnect instructions + live polling.
- Backend stage machine: likely a new pre-`pending_admin` stage or an orthogonal
  `network_configured` flag, so it composes with the existing `pending_admin → … → live`
  spine rather than reordering it. **Decide during P3** — least-invasive option preferred.

---

## 6. Security

- **AP auth.** Headless box has no screen for a per-unit PSK. Options: (a) **open AP** + rely
  on the admin-password gate + a short setup window — simplest, but anyone nearby can join
  during setup; (b) **WPA2 with a label PSK** (printed sticker / derived from serial) —
  safer, needs a label step in flashing. **Decision required.**
- **User WiFi PSK** stays in memory → written to a root-owned NM connection. Never logged,
  never echoed back over the API.
- Existing onboarding auth still applies on the AP-reachable surface.

---

## 7. Implementation plan (phased)

| Phase | Repo | Work | Gate |
|---|---|---|---|
| **P0** | — | **Hardware probe** (§2) on reference box + agentbox2. Fill in the decision table. | **BLOCKING — do first.** |
| **P1** | monorepo | `agentbox-onboarding-ap.service` + NM AP profile + install stage; bind sidecar to `0.0.0.0`; teardown logic. | `bash -n` clean; AP reachable; sidecar served on `10.42.0.1:9200`. |
| **P2** | sidecar | `features/network.py` — scan/join/status; auth-gated; PSK never logged. | Verified against mock + real `nmcli`. |
| **P3** | sidecar | `connect-network` wizard step + handoff UX; stage-machine composition. | `tsc` clean; verified at 390px (mock backend harness). |
| **P4** | both | Captive portal, mDNS/avahi discovery, security hardening (§6 decision), iOS/Android polish. | On-box dogfood, both phone OSes. |

---

## 8. Open questions

1. ~~**Uplink model**~~ — **RESOLVED 2026-06-25:** no concurrency fleet-wide → build
   **A-when-cabled-else-B** (carrier-detect at AP bring-up). See §2 P0 result.
2. **AP auth** — open vs WPA2-with-label-PSK (§6).
3. **Stage-machine shape** — new pre-stage vs orthogonal `network_configured` flag (§5.2).
4. **Discovery** — mDNS, Tailscale, or both, for the reconnect case (§4)?
5. ~~**Which units ship with WiFi modules?**~~ — **MOSTLY RESOLVED 2026-06-25:**
   agentbox1/2/honduras all carry RTL8822CE (uniform BOM). agentbox3 still unprobed.

---

## 9. Risks

- **HW can't do AP** → whole approach falls back to USB device-mode / ethernet+QR. Mitigated
  by P0 being first.
- **No concurrent AP+STA** → the §4 reconnect dance, the weakest UX; needs solid discovery.
- **Captive-portal detection** differs across iOS/Android/desktop — keep it as polish, not a
  dependency for core flow.
- **JP7.2 NetworkManager quirks** on Jetson (see `provisioning/PORT-NOTES-jetpack-7.2.md`).
- **Open AP window** is an attack surface — keep it short and behind the auth gate.
