# Spec — On-Appliance Kiosk Display (ambient dashboard panel)

**Version:** 0.1.0
**Date:** 2026-05-30
**Status:** Proposed
**Milestone:** M6 — Added features
**Linear:** [MBOX-404](https://linear.app/staqs/issue/MBOX-404)

---

## TL;DR

Let an operator plug a monitor into the Jetson and see the dashboard (queue / status)
on-screen as an ambient panel, via a **minimal opt-in kiosk stack** — bare X + a 2 MB
window manager + a lightweight browser pointed at the local dashboard. **Not Electron**
(zero upside on an already-swapping 8 GB box), and **opt-in only** so it never touches
the M5 lean headless baseline. Target footprint ~185 MB resident; auth handled by hitting
the dashboard container on loopback (bypassing Caddy basic_auth).

---

## 1. Motivation

The dashboard is already a web app (Next.js 14, served via Caddy basic_auth, `basePath
/dashboard`). Operators reach it from their own laptop/phone over LAN/tailnet. This feature
covers the **physically-present "glance at the box" use case**: a wall-mounted or
desk monitor showing the live approval queue / system status without anyone logging in.

This is an M6 *added feature*, not roadmap-foundational. It is **optional per appliance**.

## 2. Hard constraint: memory, and the M5 tension

Measured on M1 (`mailbox.heronlabsinc.com`, 2026-05-30):

| Signal | Value | Implication |
|---|---|---|
| MemAvailable | ~2.3 GiB | Only ~750 MiB slack above the 1.5 GiB backfill-abort floor |
| Swap in use | **855 MiB** | Box is *already* swapping (amber/red on `swap_in_use` stat) |
| Default target | `multi-user.target` | Headless; no GNOME/display-manager resident |
| X binaries | `Xorg`/`startx`/`xinit` present | No big X package pull needed |
| GPU | `/dev/dri/{card0,renderD128}` | Same unified pool Ollama/llama.cpp draw from |
| Browser | none installed | Clean slate |

**M5 track 1 explicitly kills the GUI** (`multi-user.target`, disable `gdm3`, purge
gnome-shell) to reclaim ~300–500 MB. This feature re-adds a display stack and therefore
**must not be part of the lean baseline**. Reconciliation:

- The lean headless baseline stays the default and unchanged.
- The kiosk is an **opt-in package + systemd unit** an operator enables only when a screen
  is physically attached. Disabled → zero resident cost.
- The kiosk stack is the *minimal* one (~185 MB), an order of magnitude under the full DE
  M5 removed — so even when enabled it doesn't undo M5's intent.

## 3. Why not Electron

The dashboard is a URL, not a packaged desktop app. Electron buys nothing here and costs:

| Stack | ~Resident RSS | Verdict |
|---|---|---|
| Electron `--kiosk` | 300–450 MB | **Rejected** — bundles a 2nd Chromium, new host-level update surface *outside* GHCR/OTA |
| `chromium --kiosk` | 250–400 MB | Fallback if WPE mis-renders the Next.js app |
| **`cog` / WPE-WebKit** | **80–160 MB** | **Recommended** — purpose-built embedded kiosk |
| X server | 40–80 MB | already present |
| matchbox-window-manager | 2–5 MB | embedded standard; lighter than openbox (~12 MB) |

Recommended stack: **`Xorg` + `matchbox-window-manager` + `cog` (WPE-WebKit)** ≈ ~185 MB.
Chromium-kiosk is the documented fallback if the dashboard doesn't render cleanly under
WebKit (verify-then-commit during the spike).

## 4. Auth path

Caddy does basic_auth, not Next. **Do not** embed `admin:$PW@` in the kiosk URL (leaks into
`/proc/<pid>/cmdline` and shell history). Instead point the kiosk at the dashboard container
on **loopback, bypassing Caddy**:

```
http://localhost:<published-port>/dashboard/queue      # or /dashboard/status
```

Prerequisite to verify in the spike: the dashboard port must be published to the host. The
approve→send loop uses internal docker DNS (`http://n8n:5678/...`), so the dashboard may
currently be network-internal only. If so, either publish the port bound to `127.0.0.1` only,
or run the kiosk browser inside the docker network. Keep `/dashboard` basePath in the URL.

## 5. GPU contention

Chromium/WPE will try GPU compositing on `renderD128` — the same unified pool Ollama/llama.cpp
use (cf. the 138 CUDA-buffer-alloc restarts in DR-25). Cap it:

- `cog`/WPE: run with limited/disabled GPU compositing.
- `chromium`: `--disable-gpu-compositing` (or `--disable-gpu` if jank is acceptable).

## 6. Lifecycle & provisioning

- **systemd unit** (`Restart=always`) starts `startx` → WM → browser at boot when enabled.
- **Opt-in toggle**: an enable/disable script or an env/flag the operator sets; default disabled.
- **Bootstrap**: `scripts/factory-bootstrap.sh` (M5 track 2) gains an *optional* "kiosk"
  step that installs `matchbox-window-manager` + `cog`/WPE and drops (but leaves disabled)
  the systemd unit. NOTE: per the M5 audit the factory bootstrap is currently avahi-only /
  largely unbuilt — this step is additive whenever bootstrap is actually built.
- **Host-level dependency caveat**: this is the **first host-level UI dependency** on an
  otherwise fully-containerized, GHCR-OTA appliance. Accepted for a single trusted appliance;
  documented as a new (small) maintenance surface outside the Docker/OTA story.

## 7. Power

`<25 W` sustained budget. X + idle browser adds ~1–3 W (external monitor not counted).
Validate with a measured before/after during the spike.

## 8. Acceptance criteria

1. With a monitor attached and the kiosk **enabled**, the box boots straight into the
   dashboard queue/status fullscreen, no WM chrome, no cursor idle, no login prompt.
2. Kiosk survives a browser/X crash (systemd `Restart=always` brings it back).
3. Resident RSS of the kiosk stack ≤ ~200 MB; `memory_pressure` and `swap_in_use` stats
   re-checked on M1 after enabling and do not cross into red beyond pre-existing baseline.
4. Kiosk **disabled** (default) → zero resident cost; lean headless baseline unchanged.
5. No basic_auth credentials present in process args, env, or shell history.
6. Power draw delta measured and within the <25 W envelope.

## 9. Out of scope

- Touch input / interactive approve-from-the-panel (read-only ambient display first).
- Multi-monitor.
- Any change to the default lean baseline or M5 hardening.
- Pushing the kiosk to the fleet by default (opt-in per appliance only).

## 10. Open questions

- **Q1** Is the dashboard port published to the host today, or network-internal only?
  (Determines loopback-vs-in-network kiosk.)
- **Q2** WPE/cog renders the Next.js dashboard cleanly? If not, fall back to chromium-kiosk.
- **Q3** Toggle mechanism — dedicated `bin/` script vs an env flag consumed by bootstrap?

## 11. Suggested phases

1. **Spike** — on M1: install `cog`+matchbox, hand-launch against the loopback URL, verify
   render + measure RSS/power/`memory_pressure`. Resolve Q1/Q2.
2. **Package** — systemd unit + enable/disable script, default disabled.
3. **Bootstrap hook** — optional kiosk step in `factory-bootstrap.sh` (additive).
4. **Docs** — operator note: "attach a screen" runbook + reversal.
