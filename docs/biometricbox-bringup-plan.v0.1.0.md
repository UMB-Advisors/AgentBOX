# biometricBOX Bring-Up — Execution Plan (on-device, agentbox1)

## v0.1.0

> **Created:** 2026-06-07
> **Source PRD:** `~/Downloads/biometricbox-bringup-prd-v0_1-2026-06-07.md`
> **Target:** agentbox1 (Jetson Orin Nano, T2) — tailscale `100.120.102.45` / `agentbox1.tail377a9a.ts.net`, ssh as the box's service user
> **Status:** BLOCKED — agentbox1 offline (last seen ~40 min before this plan). No device-side step can start until it's online.

**TL;DR** — Hardware is already wired (operator-done; do not touch wiring). This is pure software bring-up of an `fpd` UART fingerprint daemon. Per locked decisions: code lives **inside `agentbox-main/biometricbox/`**, everything is **built directly on the device over SSH** (no host-side scaffold), and v0.1 emits match events to a **Unix domain socket only**. Work proceeds T1→T8; each task has a runnable accept-check. Probe the baud, never hardcode it.

---

## Locked decisions (this session)

| Decision | Choice | Consequence |
|---|---|---|
| Repo home | `agentbox-main/biometricbox/` | Lives in the existing agentbox-main tree; commits ride that repo. Verify agentbox-main is checked out on agentbox1 (T0). |
| Build location | On-device only | Nothing scaffolded on the workstation. All `fpd` code authored over SSH on the Jetson. |
| Event sink (v0.1) | Unix domain socket only | `/run/fpd/events.sock`. HTTP/n8n sink deferred (FR-B8 second path = later). |

---

## Pre-flight blocker

**agentbox1 is offline.** Before anything below: get the box powered + on tailscale, confirm `ssh agentbox1` lands, and confirm the fingerprint module is physically connected. Then start at T0.

```bash
tailscale status | grep agentbox1        # expect: active, not "offline"
ssh <user>@100.120.102.45 'uname -a; cat /etc/nv_tegra_release | head -1'
```

---

## T0 — Orient on-device (new; precedes PRD T1)

- Confirm Jetson model + L4T/JetPack version (drives getty unit name: `nvgetty` vs `serial-getty@ttyTHS1`).
- Confirm `agentbox-main` is present on the box and on a clean branch; if not, clone/pull it. Create `biometricbox/` subdir.
- Identify the service account the daemon will run as (do **not** run as root — NFR-B2). Likely the existing box user; confirm.
- Write `biometricbox/STATE.md` as ground truth (detected baud goes here once known; per §11 + project convention).
- **Accept:** SSH in, `agentbox-main` on a known branch, `biometricbox/` exists, service account chosen.

## T1 — Enable the UART (FR-B1)
- Find what owns the console on `ttyTHS1`: `systemctl | grep -iE 'getty|nvgetty'`.
- Disable it persistently: `sudo systemctl disable --now nvgetty` (or `serial-getty@ttyTHS1.service` — use the unit that actually exists on this image).
- Confirm free: `sudo lsof /dev/ttyTHS1` returns empty.
- **Reboot, re-check** (this is the #1 silent-dead-port cause — §8).
- **Accept:** after reboot, `ls -l /dev/ttyTHS1` present and `lsof` shows it unclaimed.

## T2 — Permissions (FR-B2, NFR-B2)
- Add service account to `dialout`: `sudo usermod -aG dialout <user>` (requires fresh login/session to take effect — §8).
- If group access is insufficient on this image, add a udev rule under `/etc/udev/rules.d/` granting the group access to the Tegra HS UART.
- **Accept:** as the service account (no sudo), a one-liner `python3 -c "import serial; serial.Serial('/dev/ttyTHS1')"` opens without `PermissionError`.

## T3 — Project scaffold (FR-B4 deps)
- `biometricbox/fpd/` Python package; `uv` venv (operator's preferred tool) or system Python per Jetson convention. Pin `pyserial` + `pyfingerprint`; add `Jetson.GPIO`/`libgpiod` only if T7 is in play.
- Config loader (TOML or env — NFR-B5, no hardcoded baud/paths/sinks). Config keys: `port`, `baud_override`, `sink_socket`, `poll_interval`, `mode`.
- **Accept:** `python -m fpd info` runs without import errors (may fail to reach sensor — fine here).

## T4 — Baud probe + handshake (FR-B3, FR-B4) — *first real-sensor step*
- Implement candidate-baud probe over `[57600, 115200, 19200, 9600]`; lock onto first that gives a valid `VerifyPassword`/`ReadSysPara`. Log + record detected baud in `STATE.md`.
- Protocol wrapper: try `pyfingerprint` first; if handshake returns garbage/fails (capacitive variant), fall back to vendored packet impl. Checksum = sum of bytes packet-type→payload; length is **big-endian** (§8 framing note).
- Command set (FR-B4): `VerifyPassword, ReadSysPara, GetImage, Image2Tz, RegModel, Store, Search, DeleteChar, Empty, TemplateCount`.
- **Accept:** `python -m fpd info` prints detected baud + status register + capacity + template count from the real sensor.

## T5 — Enroll / search / manage CLI (FR-B6, FR-B5)
- `enroll [--id N]` (two-pass → `RegModel` → `Store`), `search`, `count`, `delete --id N`, `clear-all --yes`, `info`.
- **On-module matching only** — no images/templates ever written to host disk/swap/logs (DR-58, NFR-B1). Logs carry template **IDs** + results only.
- **Accept:** enroll a finger → `count` increments; `search` same finger → returns its ID.

## T6 — Daemon + event emission (FR-B7, FR-B8, FR-B10)
- Long-lived loop, **exclusive** port ownership (concurrent open fails loudly — NFR-B3). Poll for finger-present → `Search` → emit JSON match event to `/run/fpd/events.sock` (schema §6). All sensor commands timeout-bounded; unplugged/hung sensor → logged error + degraded health, no wedge (NFR-B4, SM-100).
- systemd unit `fpd.service`: `Restart=on-failure`, journald logging, runs as the unprivileged service account, `RuntimeDirectory=fpd` for the socket. Place under `agentbox-main/systemd/` to match the existing pattern.
- **Accept:** `systemctl status fpd` active; present enrolled finger → match event lands on the socket (verify with a tiny socket reader); latency < 1.5 s (SM-99).

## T7 — OPTIONAL WAKEUP interrupt mode (FR-B9)
- Only if pin 7 is in use. `Jetson.GPIO`/libgpiod edge-trigger `Search`; config `mode = "interrupt"`. Polling is the v0.1 default — **skip unless asked.**

## T8 — Smoke test (FR-B11)
- `biometricbox/smoke.sh`: handshake → prompted enroll → search → assert event emitted; non-zero exit + clear diagnostic on any failure.
- **Accept:** green on the wired box; red with a clear message when the sensor is unplugged.

---

## Risk / watch-list (pre-loaded from PRD §8)
- Console re-grabs `ttyTHS1` → `ReadSysPara` times out. Re-check T1 first, always.
- Wrong baud → probe exists for exactly this; never hardcode 57600.
- `pyfingerprint` rejects a capacitive variant → fall back to vendored wrapper, don't fight the library.
- `dialout` not effective until fresh session, or needs a udev rule on this image.
- Flaky touch-wake → suspect module pin 6 (3.3VT). **Hardware** — flag to operator, do not "fix" in software.

## Open items carried from PRD §11 (not resolved here)
- Module chipset/default baud unknown → resolved at runtime by T4 probe; record in STATE.md.
- **NC-47** BIPA/biometric consent surface — legal read (Dustin/Taylor) before first real enroll in regulated states.
- **NC-48** sensor-swap template loss — needs a re-enroll runbook before any production unit.
- **NC-49** 40-pin header allocation policy — recorded; no live conflict on single-pack T2.

## Out of scope for v0.1 (deferred — §10)
PAM login, dashboard UI, Postgres `biometric.identities` mapping, per-action confirmation gate, HTTP/n8n sink, multi-pack header arbitration.
