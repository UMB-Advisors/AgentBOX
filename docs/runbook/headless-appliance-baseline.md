# Headless appliance baseline — runbook

Per **STAQPRO-201**: the appliance ships GUI-free. Default target is
`multi-user.target`; GNOME desktop stack (gdm3, gnome-shell, Xorg, ibus,
ubuntu-desktop) is purged.

This file documents:

- **What was removed** and why
- **How to verify** the GUI is truly gone (post-deploy / post-flash check)
- **How to reverse** if a customer ever needs to attach a monitor for
  emergency debug

If you find this file and the appliance has a GUI running, something has
regressed — see "Reverse: re-enable GUI for emergency debug" below to
understand the on-purpose escape hatch vs. a regression.

## What was removed

| Removed | Why |
| --- | --- |
| `graphical.target` as default | No display attached; gdm3 was running for nobody |
| `gdm3` service + binary | ~30 MB resident + dbus/accessibility attack surface |
| `gnome-shell` | ~200 MB resident — single biggest win |
| `xorg-server` | ~110 MB resident |
| `gnome-session*`, `gnome-software`, `ubuntu-desktop`, `ubuntu-desktop-minimal` | Cascade orphans after the above are gone |
| `yaru-theme-*` | Visual theme assets, no headless use |
| `ibus`, `ibus-data` | Input method daemons; only useful with a GUI |

**Total reclaimed**: ~395 MB resident RAM, ~1-2 GB disk, ~2-3 s boot time.

## What was kept (intentionally)

- **`tailscaled`** — primary remote access path. Active before / during /
  after the purge. Verified post-reboot.
- **`ssh.service`** — secondary remote access path. Listens on all
  interfaces (Tailscale, direct ethernet `10.42.0.2`, LAN `192.168.1.45`).
- **`docker.service`** + the 6 mailbox containers (postgres, qdrant,
  ollama, n8n, caddy, mailbox-dashboard) — the actual product.
- **`nvidia-container-toolkit`** — Ollama GPU passthrough depends on it.
  Not a GUI dep but worth confirming after any apt churn.

## How to verify it's truly headless (post-deploy check)

```sh
# 1. Default target is multi-user, not graphical
systemctl get-default
# Expected: multi-user.target

# 2. No GUI processes running
pgrep -af "gnome|gdm|Xorg|ibus" || echo "none — good"
# Expected: "none — good"

# 3. gdm3 service is gone (purged) or at least disabled
systemctl status gdm3 2>&1 | grep -E "could not be found|inactive|disabled"
# Expected: "could not be found" (purged) OR "inactive (dead)" (disabled-only)

# 4. All 6 mailbox containers healthy
docker compose -f ~/mailbox/docker-compose.yml ps --format "table {{.Service}}\t{{.Status}}"
# Expected: postgres / qdrant / ollama / n8n / caddy / mailbox-dashboard all "Up ... (healthy)"

# 5. NVIDIA runtime still works (Ollama GPU passthrough)
docker compose -f ~/mailbox/docker-compose.yml exec ollama nvidia-smi 2>&1 | head -5
# Expected: NVIDIA-SMI banner + GPU table (NOT "command not found")

# 6. SSH reachable on all 3 paths from the workstation
ssh jetson-tailscale 'hostname'   # tailnet (primary)
ssh jetson 'hostname'             # direct ethernet (fallback)
ssh jetson-wifi 'hostname'        # LAN (fallback)
# Expected: all three return the hostname
```

## Reverse: re-enable GUI for emergency debug

If a customer ever needs to physically attach a monitor + keyboard (e.g.,
to debug a network failure that's killed all 3 SSH paths simultaneously —
should never happen, but cover it):

### Option A: minimal X11 only (recommended, ~50 MB)

If you just need a console to type commands at a physically-attached
monitor:

```sh
# Add a kernel arg or just login on tty1 — no apt changes needed.
# Multi-user.target already provides tty1-tty6 console logins.
# Press Ctrl+Alt+F1..F6 on the attached keyboard.
# Login as bob, run sudo whatever you need.
```

This requires nothing — the multi-user target already gives tty consoles.
No GUI is needed for emergency console access. Try this first.

### Option B: reinstall full desktop (last resort, ~5-10 min)

```sh
# 1. Restore the systemd default target
sudo systemctl set-default graphical.target

# 2. Reinstall the desktop metapackage. This pulls hundreds of deps —
#    on a Jetson with 7% disk used, plenty of room.
sudo apt update
sudo apt install -y ubuntu-desktop ubuntu-desktop-minimal

# 3. Re-enable + start gdm3 (will be installed with ubuntu-desktop)
sudo systemctl enable --now gdm3

# 4. Reboot to bring up the graphical session
sudo reboot
```

On the next boot a normal GNOME login screen appears on the attached
monitor. The mailbox docker stack will continue running through the
reboot — Docker doesn't depend on GUI.

### Restoring headless after the emergency

Once debug is done, reverse Option B:

```sh
sudo systemctl set-default multi-user.target
sudo systemctl disable --now gdm3
sudo apt purge gnome-shell 'gnome-session*' gdm3 'yaru-theme-*' \
  ibus ibus-data ubuntu-desktop ubuntu-desktop-minimal
sudo apt autoremove --purge
sudo reboot
```

Then re-run the verification checks above.

## Customer #2 imaging (STAQPRO-174)

The pinned-stack image for customer #2 should ship GUI-free from day one.
Bake this into the imaging procedure:

1. After base Ubuntu install, do NOT install `ubuntu-desktop` /
   `ubuntu-desktop-minimal`. If the image template includes them, the
   imaging script must run the purge above before the snapshot is taken.
2. `multi-user.target` should be the default before snapshotting.
3. SSH + Tailscale must be enabled and started in the snapshot.

Reference STAQPRO-201 in the imaging runbook so the rationale is
discoverable.

## Why we don't run `ubuntu-server` instead

A reasonable suggestion: "why not flash with the Ubuntu Server image
instead of Ubuntu Desktop, then no purge needed?" Two reasons:

1. The JetPack image is built on Ubuntu Desktop. NVIDIA's flash tooling
   defaults to it. Flashing with stock Ubuntu Server would lose JetPack's
   pre-configured CUDA drivers, which means more setup time per appliance
   (counterproductive for the customer-N-onboarding runbook).
2. The cost of the desktop stack is one-time per-appliance. The purge
   takes ~5 min; the imaging benefit lasts the appliance lifetime.

Documented for future ops who consider re-flashing.
