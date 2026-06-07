# MailBox Factory Flash Runbook v0.1.0

**Status:** DRAFT — screenshots TODO; will land in a follow-up commit when Dustin runs the first real flash session and captures SDK Manager UI state. Procedure itself is canonical for customer #3+ appliances.

**Audience:** Operator preparing a seed NVMe for the STAQPRO-409 golden-image batch pipeline. Assumes Dustin or successor with workstation access.

**Tracks:** STAQPRO-225 (this work). Related: STAQPRO-409 (golden-image pipeline that consumes this seed NVMe), STAQPRO-410 (factory-bootstrap.sh — runs on the appliance after this runbook completes), STAQPRO-201 (post-flash GNOME purge — what this supersedes for customer #3+), STAQPRO-202 (factory-bootstrap.sh predecessor; status drift flagged — see §8).

---

## How to use this doc

- Each numbered section maps to one phase of the SDK Manager flash flow.
- `TODO:` markers are walkthrough capture points — Dustin will fill these in (especially screenshots) during the first real flash session.
- `OPEN Q:` markers are decisions/lookups that need a real answer before v1.0.0.
- Bump file version on revision: patch for typos, minor for added sections, major for structural rewrite.
- Screenshots referenced as `./screenshots/sdk-manager-*.png` are **not yet committed**; the doc lands first so the procedure is reviewable, screenshots land in a follow-up commit (STAQPRO-225 follow-up).

---

## 1. Pre-flight

**Goal:** Workstation and hardware are ready before opening SDK Manager.

- [ ] Workstation is Ubuntu 22.04 x86_64 (SDK Manager does not support macOS or Windows for Jetson flashing)
- [ ] SDK Manager installed via the `.deb` package from https://developer.nvidia.com/sdk-manager
- [ ] NVIDIA Developer account exists and is logged in to SDK Manager (free account; see note below)
- [ ] USB-A → USB-C cable connected between workstation and Jetson's USB-C recovery port (use a short cable — long cables cause recovery-mode detection failures; see §7)
- [ ] Blank NVMe seated in the Jetson Orin Nano Super dev kit M.2 slot
- [ ] ~30 GB free disk space on workstation (SDK Manager caches BSP + rootfs here)

`OPEN Q:` SDK Manager downloads JetPack components to the workstation at login time. The download size and the NVIDIA account requirement are accepted costs of Approach A (vs. STAQPRO-201's post-purge path, which needed no SDK Manager session). Document the exact download size for JetPack 6.2 once observed in a real session.

`TODO:` Capture whether the NVIDIA account must have "JetPack" entitlement activated or whether any free account works. First-flash session will confirm.

---

## 2. Recovery mode

**Goal:** Jetson is enumerated as a USB device on the workstation before launching SDK Manager.

- [ ] Power off the Jetson completely (not sleep — full power off)
- [ ] Locate the Force Recovery (FC REC) pin and an adjacent GND pin on the 40-pin header of the dev kit
- [ ] Bridge FC REC to GND with a jumper or a pre-bent paperclip (the two pins are adjacent on the Orin Nano Super dev kit; refer to the hardware manual if unsure which pair)
- [ ] Connect the USB-C cable between the Jetson's USB-C port and the workstation
- [ ] Power on the Jetson (leave the jumper in place)
- [ ] On the workstation, verify the device appears:

```bash
lsusb | grep -i nvidia
```

Expected output includes a line like:

```
Bus 001 Device 005: ID 0955:7523 NVidia Corp. APX
```

- [ ] Confirm the device ID is `0955:7523` (APX) — any other NVIDIA device ID means recovery mode was not triggered; power off and re-seat the jumper

`TODO:` Capture the exact `lsusb` line from a real recovery-mode session and replace the expected output above.

`OPEN Q:` Confirm the correct header pin numbers for FC REC and GND on the Orin Nano Super dev kit. The hardware manual is the source of truth; the jumper location should be photographed and committed as `./screenshots/recovery-jumper.png`.

---

## 3. SDK Manager flow (Approach A)

**Goal:** Flash JetPack 6.2 Jetson Linux onto the NVMe with the desktop/CUDA stack excluded from the image.

This is the core of Approach A (locked in STAQPRO-225 2026-05-18): drop `ubuntu-desktop` and the GUI SDK components at flash-time rather than purging them post-flash (STAQPRO-201 path). The result is a smaller rootfs and one fewer manual step per appliance.

### Step 1 — Product selection

In SDK Manager's first screen:

- **Hardware Configuration → Target Hardware:** "Jetson Orin Nano Developer Kit (8GB)"
- **Target Operating System:** Linux / JetPack 6.2 (select the current latest 6.2.x point release)
- **Host Components:** keep the default (SDK Manager may pre-check CUDA host-side tools; these install on the workstation only and do not affect the Jetson rootfs)

![SDK Manager Step 1 — product and JetPack selection](./screenshots/sdk-manager-step-1.png)

> TODO: screenshot pending first real flash session — Dustin to capture and commit in STAQPRO-225 follow-up.

`TODO:` Record the exact JetPack 6.2.x point release selected (e.g. 6.2.0 vs 6.2.1) and lock this runbook to that version. Pin by point release, not by major/minor, so golden images are bit-reproducible.

### Step 2 — Component selection (critical)

This is where Approach A diverges from a default flash. SDK Manager presents two component groups:

**UNCHECK:** "Jetson SDK Components" — this group includes CUDA, cuDNN, TensorRT, multimedia APIs, developer samples, and supporting packages that pull in `ubuntu-desktop` as a dependency. Unchecking this group is the single action that keeps the GUI stack out of the image.

**KEEP CHECKED:** "Jetson Linux" — this is the kernel, bootloader, BSP packages, and the minimal `nv-tegra` rootfs. This is everything the appliance needs to boot.

**Why we skip Jetson SDK Components:** CUDA and cuDNN are consumed by the appliance exclusively inside containers. The `ollama/ollama` upstream image (digest-pinned per appliance per STAQPRO-240; see CLAUDE.md "Stack Patterns by Variant") bundles its own CUDA runtime and communicates with the host GPU via `nvidia-container-toolkit`. The host-side CUDA stack costs nothing on this architecture; the GUI desktop is pure overhead on a headless server appliance.

![SDK Manager Step 2 — uncheck Jetson SDK Components](./screenshots/sdk-manager-step-2.png)

> TODO: screenshot pending first real flash session — Dustin to capture and commit in STAQPRO-225 follow-up. The screenshot must show "Jetson SDK Components" unchecked and "Jetson Linux" checked.

### Step 3 — Target setup

- **Storage device:** NVMe (`/dev/nvme0n1`) — select NVMe as the flash target, not eMMC
- **Pre-config:** leave the defaults unless you have a specific hostname requirement; the `factory-bootstrap.sh` script (STAQPRO-410) re-sets the hostname and regenerates SSH host keys as part of the first-boot prep, so the SDK Manager defaults are not permanent
- **Username / password:** set a placeholder like user `mailbox` with a known temporary password — these credentials are overridden by `factory-bootstrap.sh` during the STAQPRO-410 step; avoid leaving a well-known default like `nvidia`/`nvidia`

`OPEN Q:` Confirm whether the SDK Manager "Storage Device" dropdown lists the NVMe by path (`/dev/nvme0n1`) or by label. The Orin Nano Super dev kit routes both NVMe and eMMC through the same flash path — verify the target before clicking Flash.

### Step 4 — Flash

- Click "Flash" to begin
- Expected wall-clock time: 20–30 minutes (BSP + rootfs write to NVMe)
- Do not unplug the USB cable or lock the workstation during the flash window (SDK Manager auth can time out — see §7)
- End state: SDK Manager reports "Installation finished successfully"; the Jetson rootfs is on the NVMe and the board is ready for first boot

`TODO:` Record the exact elapsed time from a real session and update the estimate above.

---

## 4. First-boot verification

**Goal:** Jetson boots headless from the NVMe with no GUI desktop installed; SSH access confirmed.

- [ ] Remove the recovery jumper from the FC REC / GND pins
- [ ] Power-cycle the Jetson
- [ ] Find the appliance's IP address — options (pre-bootstrap, no mDNS yet):
  - Check SDK Manager's reported IP at the end of the flash step
  - `arp -a` on the workstation (must be on the same LAN segment)
  - Connect a USB-serial console cable to the Jetson's UART header (see Orin Nano Super hardware manual)
- [ ] SSH in with the username and password set in Step 3:

```bash
ssh mailbox@<appliance-ip>
```

- [ ] Confirm kernel and memory:

```bash
uname -r
free -h
```

Expected: kernel `5.15.x-tegra`; free memory ~1.5 GB at idle (OS + JetPack baseline; no containers running yet).

- [ ] Confirm rootfs free space:

```bash
df -h /
```

Expected: significantly more free space than a default JetPack flash (which installs CUDA, cuDNN, TensorRT, and samples). The Approach A rootfs should leave the majority of the NVMe available.

- [ ] **Critical verification — confirm no desktop installed:**

```bash
dpkg -l | grep ubuntu-desktop
```

This command must return **no output**. If `ubuntu-desktop` appears, the Step 2 uncheck was not applied correctly and the image must be reflashed.

This is the value-prop of Approach A: the desktop stack is not in the image to begin with, so there is nothing to purge. The STAQPRO-201 post-flash purge step is eliminated entirely for customer #3+ appliances using this path.

`TODO:` Capture actual `free -h` and `df -h /` output from a real first-boot session and update the expected values above.

---

## 5. Hand-off to STAQPRO-410 + STAQPRO-409

**Goal:** Seed NVMe is bootstrapped with Docker + nvidia-container-toolkit and ready for golden-image capture.

At this point the Jetson has a clean, headless JetPack 6.2 rootfs. The next two steps in the pipeline are:

1. **STAQPRO-410 — Run `factory-bootstrap.sh`** on the appliance. This script installs Docker via JetsonHacks (not `docker-ce` — see CLAUDE.md "What NOT to Use"), installs and configures `nvidia-container-toolkit`, sets the permanent hostname, regenerates SSH host keys, and performs any other one-time host-level prep needed before the MailBox compose stack is deployed. The script lands on master when STAQPRO-410 merges; reference its location as `scripts/factory-bootstrap.sh` once merged.

```bash
# On the appliance after first SSH login
curl -fsSL https://raw.githubusercontent.com/UMB-Advisors/mailbox/master/scripts/factory-bootstrap.sh | sudo bash
```

`OPEN Q:` Confirm the correct execution path for `factory-bootstrap.sh` once STAQPRO-410 is merged — curl-pipe vs. `git clone` then run locally. Curl-pipe is faster for a pristine box with no repo yet; git clone is more auditable.

2. **STAQPRO-409 — Golden-image capture.** Once `factory-bootstrap.sh` completes, power off the Jetson, pull the NVMe, and capture it as a golden image per `docs/runbook/factory-image-pipeline.v0.1.0.md`. The resulting image is the seed for all customer #3+ appliances in the STAQPRO-409 batch pipeline.

Hand-off checklist:

- [ ] `factory-bootstrap.sh` exits 0
- [ ] GPU passthrough verified post-bootstrap: `docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi`
- [ ] `docker compose ps` shows expected services healthy (or stack not yet deployed — `factory-bootstrap.sh` scope is host prep only, not the full stack)
- [ ] Power off cleanly: `sudo shutdown -h now`
- [ ] Pull NVMe from Jetson
- [ ] Proceed to `docs/runbook/factory-image-pipeline.v0.1.0.md` (STAQPRO-409)

---

## 6. Recovery / reversal

**Goal:** Known paths for mid-flash failure and post-flash desktop re-install if ever needed.

### Mid-flash failure

If the SDK Manager flash fails partway through:

- [ ] Check USB cable connection and retry (most failures are USB enumeration issues — see §7 footguns)
- [ ] Confirm the Jetson is still in recovery mode (`lsusb | grep -i nvidia` should still show APX; if not, power cycle with jumper reseated)
- [ ] Re-run from SDK Manager Step 4 — the tool supports re-flash; it will overwrite the partial write
- [ ] If failures persist, try a different USB port on the workstation or a different USB-A → USB-C cable

For persistent issues, refer to the NVIDIA forums: https://forums.developer.nvidia.com/c/agx-autonomous-machines/jetson-embedded-systems/70

Common root causes of flash failure:
- USB cable too long (signal integrity) — use a cable ≤ 1m
- USB 3.0 hub in the path — connect directly to a workstation USB port
- Workstation USB power management suspending the device mid-flash — disable USB autosuspend before flashing
- Recovery jumper not fully seated — pins are small; verify contact with a multimeter or try a proper 2-pin jumper instead of a paperclip

### Re-installing the desktop (post-flash, if needed)

If a future use case requires a GUI console on the appliance:

```bash
sudo apt update && sudo apt install -y ubuntu-desktop
```

The value of this runbook is precisely that the desktop is not present to begin with. This command is the reversal path, not the recommended default. Re-installing the desktop adds ~1.5–2 GB to rootfs and reinstates background services (NetworkManager, Avahi, cups, etc.) that are unnecessary and potentially disruptive on a headless server appliance.

---

## 7. Known footguns

**Goal:** Document the recurring failure modes before the first operator encounters them.

### JetPack version drift

SDK Manager locks the JetPack version at flash time. A golden image created at JetPack 6.2.0 will NOT cleanly restore over a board whose bootloader was later updated to 6.2.1 — the bootloader version must match the rootfs. Re-do this runbook in full on JetPack point-release updates, and tag golden images with the exact JetPack version (e.g. `mailbox-seed-jp6.2.0-YYYYMMDD.img`).

Corollary: do not let SDK Manager auto-select the "latest" JetPack on a subsequent flash of the same batch. Pin the point release explicitly.

### NVMe brand-by-brand quirks

The two NVMe models currently deployed — SPCC M.2 PCIe SSD (mailbox1, 953.9 GB) and Kingston SNV3S1000G (mailbox2, 931.5 GB) — are both DRAM-less consumer drives. They work under the mailbox workload today, but DRAM-less NVMes are susceptible to firmware-level write stalls during sustained sequential writes (such as a fresh OS flash or a golden-image write). If a flash times out or completes unusually slowly, note the NVMe brand and part number and search the NVIDIA forums for that specific drive.

For each appliance provisioned, record the NVMe brand, model, and capacity in the appliance inventory. This is especially important when diagnosing golden-image failures.

### SDK Manager auth gotcha

SDK Manager requires an active NVIDIA Developer account session throughout the flash. If the workstation locks, the operator walks away, or the session token expires during the 20–30 minute flash window, the flash will abort at the "Pre-Config" or "Flash" stage with an auth error. The partial flash may leave the NVMe in a non-bootable state.

Mitigation: disable screen lock on the workstation for the duration of the flash session, and stay present. Re-flashing from a failed mid-point is supported but adds ~20 minutes.

### USB cable selection

The most common cause of recovery-mode detection failure is a USB cable that cannot carry the data-rate required. Use a short (≤ 1m), data-capable USB-A → USB-C cable — not a charge-only cable and not a cable longer than 1m. When in doubt, try a different cable first before investigating recovery-mode jumper seating.

---

## 8. References

**Goal:** Cross-links for context and follow-on reading.

- **STAQPRO-225** — This runbook's driving issue. Approach A decision (Jetson Linux only, skip SDK Components) locked 2026-05-18.
- **STAQPRO-201** — Post-flash GNOME purge path (the approach this runbook supersedes for customer #3+). Still the applicable path for M1 (`mailbox.heronlabsinc.com`) and M2 (`mailbox.staqs.io`) which are grandfathered.
- **STAQPRO-202** — factory-bootstrap.sh predecessor. **Status drift flag:** Linear marked STAQPRO-202 as Delivered, but the file `scripts/factory-bootstrap.sh` was net-new in STAQPRO-410's quick task 260518-vsx — the Linear status is stale. Flag for follow-up before relying on STAQPRO-202's delivered scope as a dependency.
- **STAQPRO-409** — Golden-image batch pipeline. Consumes the seed NVMe produced by this runbook. Runbook: `docs/runbook/factory-image-pipeline.v0.1.0.md`.
- **STAQPRO-410** — `factory-bootstrap.sh`. Runs on the appliance after this runbook completes, before golden-image capture. Script path: `scripts/factory-bootstrap.sh` (lands on master when STAQPRO-410 merges).
- **`docs/runbook/factory-image-pipeline.v0.1.0.md`** — Next step after §5 completes. STAQPRO-409 runbook; covers NVMe pull, image capture, and batch replication.
- **`docs/runbook/provisioning.v0.1.0.md`** — Style sibling. Covers the full appliance provisioning flow (Tailscale, Docker Compose stack, Gmail OAuth, etc.) that follows the factory-image restore step.
- **NVIDIA SDK Manager documentation** — https://docs.nvidia.com/sdk-manager/
- **L4T BSP archive (JetPack 6.2 / L4T R36.4)** — https://developer.nvidia.com/embedded/jetson-linux-r3640
- **NVIDIA Jetson developer forums** — https://forums.developer.nvidia.com/c/agx-autonomous-machines/jetson-embedded-systems/70 (recovery / flashing issues)
