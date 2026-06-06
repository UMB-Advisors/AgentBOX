# Reflash Runbook — JetPack 7.2 (Jetson Orin Nano Super 8 GB)

**What:** Clean-flash an AgentBOX Jetson from JetPack 6.2.2 (L4T R36.5) to **JetPack 7.2** (Jetson Linux **r39.2**, Ubuntu 24.04, kernel 6.8, CUDA 13), **headless — no Ubuntu desktop**.
**Why now:** JetPack 7.2 (released 2026‑05‑31, GTC Taipei) is the first JetPack 7 to support the Orin Nano family. 7.0/7.1 were Thor‑only.
**Method:** NVIDIA **SDK Manager CLI** (`sdkmanager --cli`) over **USB‑C** to a device in **Force Recovery Mode**. There is no network/Tailscale reflash path — SDK Manager's network mode only installs SDK *components* onto an already‑running box; the BSP/OS flash is USB‑only.

> [!WARNING]
> A reflash **wipes the NVMe** (root + all Docker volumes + Tailscale state + the `mailbox`/`bob` user). Complete the **Backup** section and verify the archive *off‑box* before powering into recovery mode.

> [!IMPORTANT]
> **Brand‑new release + major jump.** The `provisioning/` scripts are pinned to JetPack 6.2 / CUDA 12.6 (`00-base.sh`), and the GPU containers (`local/llama-cpp:cuda-jetson`, CUDA‑accelerated Ollama) are built against the L4T r36 / CUDA 12.6 base. On 7.2 (CUDA 13, r39.2) **these must be rebuilt** — they will not run as‑is. Treat the first 7.2 box as a migration, not a like‑for‑like restore. Keep the 6.2.2 backup until 7.2 is proven.

---

## 0. Prerequisites

| Need | Detail |
|---|---|
| Flash host | x86_64 Ubuntu 22.04/24.04. `bob-tb250-btc` qualifies (548 GB free, flash deps present, `sdkmanager` installed). |
| SDK Manager | `sdkmanager` ≥ the build that lists JetPack 7.2. Update if 7.2 isn't in `sdkmanager --cli list`. |
| NVIDIA login | Developer (devzone) account — required on first CLI run (`--login-type devzone`). |
| Cable | **USB‑C** from flash host to the Jetson's recovery USB‑C port (the one nearest the barrel jack on the Orin Nano devkit). |
| Physical access | Someone at the box to jumper recovery + power‑cycle. **HITL — cannot be done remotely.** |
| Backup | Section 1 complete and checksummed off‑box. |

---

## 1. Backup (off‑box, before anything)

Run from the flash host. Read‑only on the target; writes only to the host. (Reference implementation: `~/backups/mailbox1-backup.sh`.)

```bash
# Crown jewels:
#  - /home/bob/mailbox        compose project + .env (secrets) + Caddyfile + dashboard source
#  - postgres (pg_dumpall)    all DBs + roles
#  - docker volumes           n8n_data, qdrant_data, caddy_data/config, *_kb_uploads
#  - system meta              docker image ls, tailscale status+tags, /etc/hosts, nv_tegra_release
# Skipped (re-derivable): ollama_models (re-pull), raw postgres_data (covered by pg_dumpall),
#                         node_modules, custom GPU images (rebuilt on 7.2 — back up SOURCE not image)
```

Verify `SHA256SUMS` and that `postgres-all.sql.gz` and each `vol-*.tar.gz` are non‑zero **before** wiping.

---

## 2. Force Recovery Mode (at the box)

1. Power off the Jetson.
2. Jumper **FC REC ↔ GND** on the button header (or hold the **recovery** button).
3. Connect USB‑C host → Jetson recovery port.
4. Apply power (release the button after ~2 s).
5. On the host, confirm: `lsusb | grep -i 0955` → an `0955:7523` (or similar) NVIDIA APX device. No APX device = not in recovery; repeat.

---

## 3. Flash with SDK Manager CLI

```bash
# Discover the exact product/target/version strings first — IDs change per release:
sdkmanager --cli list --product Jetson

# Flash JetPack 7.2 to NVMe, OS image only (skip host-side SDK components for a headless box).
# Confirm the --target board id and --version string against the `list` output above.
sdkmanager --cli install \
  --login-type devzone \
  --product Jetson \
  --version 7.2 \
  --target-os Linux \
  --target JETSON_ORIN_NANO_8GB_DEVKIT \
  --select 'Jetson Linux' \
  --deselect 'Jetson SDK Components' \
  --flash all \
  --storage nvme0n1
```

> [!TIP]
> **flash.sh fallback** (no SDK Manager / fully scriptable headless seed). Unpack the r39.2 BSP + sample rootfs, then:
> ```bash
> cd Linux_for_Tegra
> sudo ./tools/l4t_create_default_user.sh -u mailbox -p '<APP_PASSWORD>' -n dustin -a --accept-license  # pre-seeds user → skips first-boot GUI wizard
> sudo ./apply_binaries.sh
> sudo ./tools/kernel_flash/l4t_initrd_flash.sh --external-device nvme0n1p1 \
>   -c tools/kernel_flash/flash_l4t_t234_nvme.xml -p "-c bootloader/generic/cfg/flash_t234_qspi.xml" \
>   --showlogs --network usb0 jetson-orin-nano-devkit-super internal
> ```

---

## 4. Headless — no Ubuntu desktop

The `l4t_create_default_user.sh` seed (above) skips the graphical first‑boot wizard. After first boot, over serial/SSH:

```bash
sudo systemctl set-default multi-user.target      # never start the desktop
sudo systemctl disable --now gdm3 nvgetty 2>/dev/null || true
# Optional, reclaims ~1.5 GB — verify nothing GPU-critical is pulled first:
sudo apt-get purge -y 'ubuntu-desktop*' 'gnome-shell*' gdm3 nvidia-l4t-graphics-demos
sudo apt-get autoremove -y
```

> [!NOTE]
> The AgentBOX kiosk (`60-kiosk*`) renders via **cog/WPE on Wayland**, not a full GNOME session — it does not need the Ubuntu desktop. Keep `multi-user.target`; the kiosk units bring up only the compositor they need.

---

## 5. Post‑flash bring‑up

1. **Network + Tailscale**
   ```bash
   sudo tailscale up --ssh        # re-auth (new node key); device must be re-tagged tag:mailbox in admin console
   ```
   Re‑apply `tag:mailbox` so the SSH ACL (`users: ["bob","mailbox"]`) and the :8090 dashboard grants apply.
2. **Docker + provisioning** — update the pins first (see caveats), then run phases in order:
   ```bash
   sudo ./provisioning/00-base.sh        # ⚠ pinned to JetPack 6.2/CUDA 12.6 — update for r39.2/CUDA 13
   sudo ./provisioning/10-inference.sh   # rebuild GPU images against the CUDA 13 base
   # … 20→70 per docs/RUNBOOK.md "First-time setup"
   ```
3. **Restore data**
   ```bash
   # repo + secrets
   tar xzf mailbox-repo.tar.gz -C /home/bob
   # postgres
   gunzip -c postgres-all.sql.gz | docker exec -i mailbox-postgres-1 psql -U postgres
   # volumes
   for v in n8n_data qdrant_data caddy_data caddy_config mailbox_kb_uploads; do
     docker run --rm -v mailbox_$v:/v -i alpine sh -c 'cd /v && tar xzf -' < vol-mailbox_$v.tar.gz
   done
   ```
4. **Rebuild GPU containers** (CUDA 13 / r39.2 base): `local/llama-cpp:cuda-jetson`, Ollama GPU. Re‑pull Ollama models.
5. **Verify:** `provisioning/verify-phase7.sh` → `PHASE7_VERIFY_OK`; dashboard reachable on `:8090`; `systemctl is-system-running` = `running`.

---

## 6. Rollback

7.2 is < 1 week old. If it misbehaves, reflash back to **6.2.2 (L4T r36.5)** via the same SDK Manager CLI (`--version 6.2.2`) and restore from the same backup — the 6.2.2 restore path is like‑for‑like (no CUDA major change). Do not delete the 6.2.2 backup until 7.2 has run clean for a full duty cycle.

---

*v0.1.0 · 2026‑06‑05 · author: ops. Verify SDK Manager target IDs and r39.2 BSP URLs against the 7.2 release notes before flashing.*
