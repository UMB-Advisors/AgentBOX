# Flashing a Jetson Orin Nano from scratch (AgentBOX)

The **from-scratch** way to get JetPack onto a bare Jetson Orin Nano Super Developer Kit
is NVIDIA's official **ISO installer** — you write an installer to a USB stick, boot the
Jetson from it, and it installs Jetson Linux onto the board's NVMe/microSD. No host PC
flashing, no recovery-mode jumper, no BSP extraction.

> **Authoritative source — follow this, it's the source of truth:**
> **[NVIDIA — Jetson Orin Nano Developer Kit Quick Start](https://docs.nvidia.com/jetson/orin-nano-devkit/user-guide/latest/quick_start.html)**
>
> The steps below are an AgentBOX-oriented summary of that page (plus the choices that
> matter for us). If NVIDIA's page and this doc ever disagree, **NVIDIA wins** — tell us so
> we can fix this.

AgentBOX targets **JetPack 7.2 (Jetson Linux r39.2, Ubuntu 24.04, CUDA 13)**, which is what
the current installer ISO delivers.

## What you need
- The Orin Nano Super Developer Kit + its **19 V** power supply
- A laptop/PC (any OS) to write the USB installer
- A **USB flash drive (16 GB+)** for the installer
- **Target storage: an NVMe SSD** (strongly recommended for AgentBOX — the install pulls
  models + Docker images and needs comfortably more than a microSD gives; a 64 GB+ UHS-1
  microSD *works* but is tight). Install it on the carrier board before you start.
- A DisplayPort monitor + USB keyboard/mouse (or a USB-TTL serial cable for headless)

## Steps (summary of the NVIDIA quick start)
1. **Check the board's firmware.** It needs JetPack-6-generation UEFI/QSPI (v36.0+). Power
   on with a monitor attached and press **Esc** at the NVIDIA splash to read the firmware
   version. If it's older than 36.0, do NVIDIA's JetPack-6 firmware-update path first.
2. **Download the Jetson installer ISO** from the
   [JetPack download page](https://developer.nvidia.com/embedded/jetpack) (the current
   `jetson-installer` r39.2 ISO = JetPack 7.2).
3. **Write the ISO to the USB stick with [Balena Etcher](https://etcher.balena.io/)** (or
   equivalent). You **cannot** just copy the `.iso` onto the stick — it must be written as
   bootable media.
4. **Install your NVMe SSD** on the carrier board (if not already).
5. **Connect** monitor + keyboard/mouse, insert the installer USB, and plug in the **19 V**
   supply (it powers on automatically; the green LED lights).
6. **Boot from USB:** press **Esc** at the splash → **Boot Manager** → select the USB disk.
7. **⚠️ Confirm the QSPI capsule update — press `Y`.** This is the most-missed step; the
   prompt **times out in ~30 s** and if you miss it the install fails later. The capsule
   update runs in two passes and may reboot between them — that's normal; let it finish.
8. **Install Jetson Linux:** at the GRUB menu choose **Install Jetson ISO r39.2**, select
   your **NVMe** (or microSD) as the target, confirm (this **erases** that device), and let
   it complete, then reboot.
9. **Remove the USB** when prompted and boot from the installed target.
10. **First-boot `oem-config`:** accept the EULA, pick language/keyboard/timezone, **connect
    to your network**, and **create your user + password + hostname**. Log in to the Ubuntu
    desktop.

## AgentBOX post-flash checklist (do these before provisioning)
- **Max performance:** click the power-mode indicator (top bar) → **MAXN SUPER** (the box
  ships in 25 W mode by default).
- **Enable SSH + get on the network:** `sudo apt update && sudo apt install -y openssh-server`,
  and make sure the box is on Wi-Fi/Ethernet with DHCP. Provisioning reaches the box **over
  the network by SSH** as the user you just created.
- Note the box's IP / `<hostname>.local` and confirm you can `ssh <youruser>@<box>`.

## Next: provision the AgentBOX
Once the box is booted, on the network, and SSH-reachable, the OS side is done — the rest is
software. SSH in and run the on-box install (this is the path that actually works from
scratch):

```bash
# on the box
git clone https://github.com/UMB-Advisors/AgentBOX.git ~/AgentBOX   # (or your fork/branch)
~/AgentBOX/install/onboarding-test-setup.sh                          # sidecar + OOBE wizard + AP
#   or, base appliance only:  ~/AgentBOX/install/agentbox-install.sh --prototype
```

See **[`demo-runbook.md`](./demo-runbook.md)** for the full end-to-end demo flow after this.

## Alternative (advanced): host-driven flash
If you specifically want to flash **from a host PC** (e.g. fully scripted, or headless
re-imaging of a fleet) rather than the on-device ISO installer, two host-driven paths exist
and remain supported — but they are **not** the recommended from-scratch method:
- **SDK Manager CLI reflash** (Force Recovery + `sdkmanager --cli`): see
  [`reflash-jetpack-7.2.v0.1.0.md`](./reflash-jetpack-7.2.v0.1.0.md).
- **BSP `l4t_initrd_flash` over USB recovery mode**: the `/agentbox-flash` skill
  (`.claude/skills/agentbox-flash/`). Its `preflight`/`mkuser`/`flash` stages are for this
  path only; on an ISO-installed box you start provisioning at the install step above.
