# Context — Phase 0: Base platform bring-up (headless)
Source PRD section: §8 Phase 0; constraints §2; hardware §3

## Decisions captured (the discuss step)
- **Execution mode:** Jetson is **SSH-reachable now**. Execute runs commands directly on the board over SSH; verification is on-device, live. (Connection details needed — see Hand-off.)
- **Storage:** **NVMe as root.** Everything (OS, weights, gbrain, node_modules) on NVMe. If the board is currently SD-booted, Phase 0 includes migrating root to NVMe (clone + extlinux/boot config) before proceeding. If already NVMe-root, skip migration and verify.
- **Python 3.11:** **uv-managed** standalone 3.11 (`uv python install 3.11`), isolated from system 3.10. All hermes-agent installs use `uv venv --python 3.11`. System Python untouched.
- **No desktop environment:** `systemctl set-default multi-user.target`; do not install gdm/gnome. GUI arrives only as the Phase 6 kiosk session.
- **zram + swap:** enable zram (zram-config or systemd-zram-generator) sized ~50% of RAM (~4 GB compressed) + a modest NVMe swapfile (~4–8 GB) as spillover for transient embed/chromium spikes. zram primary, disk swap last-resort.
- **Node + Bun:** Node LTS (nvm or NodeSource arm64) for the WhatsApp bridge + dashboard build; Bun (official arm64 install) for gbrain. Pin versions in the provisioning script.
- **CUDA:** use the JetPack-shipped CUDA 12.x; verify, do not reinstall. `nvcc`/`nvidia-smi`/`tegrastats` for checks.
- **Idempotent provisioning:** capture all Phase 0 steps in a re-runnable script under `provisioning/` (so a reflash reproduces the box). Exact-pin per Constitution §4.

## Scope boundary
Files / modules this phase may touch:
- `provisioning/` (new): `00-base.sh`, env/version pins, zram/swap config, NVMe-root steps, verification script.
- System config on the Jetson over SSH: apt packages, `systemctl` default target, zram/swap units, uv/node/bun install. No application code yet (agent/gbrain/bridge/kiosk come in later phases).
- `docs/STATE-v1.0.0.md` updated as tasks complete.

## Hand-off to executor
Acceptance criteria (mirrored from ROADMAP Phase 0):
- [ ] `python3.11 --version` ≥ 3.11 and `uv` present
- [ ] `node -v` (LTS) and `bun -v` succeed
- [ ] GPU visible (`nvidia-smi`/`tegrastats`) and CUDA 12.x (`nvcc --version`)
- [ ] `systemctl get-default` = `multi-user.target` (no DE); idle `free -m` used ≤ ~1.2 GB
- [ ] zram active (`zramctl`); root filesystem on NVMe; unattended reboot returns to SSH

## Needed from user before execute
1. **SSH target:** `user@host` (or IP) + how I authenticate (key already installed? password? jump host?). Per global CLAUDE.md, I run commands over SSH; I will not touch `~/.ssh` config without explicit instruction.
2. **Boot state:** Is the board already booted from NVMe, or SD-flashed (needs root migration to NVMe)?
3. **JetPack confirmation:** confirm `cat /etc/nv_tegra_release` shows L4T r36.x (JetPack 6).
