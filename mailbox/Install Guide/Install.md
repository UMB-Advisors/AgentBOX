1. Flash JetPack 6.2.2 onto the Jetson

  This is manual — the script does not flash the device.

  1. Install https://developer.nvidia.com/sdk-manager on a host PC (Ubuntu x86)
  2. Connect the Jetson Orin Nano Super to the host via USB-C while holding the recovery button (or jumper the recovery pins)
  3. In SDK Manager, select JetPack 6.2.2 (r36.5) as the target
  4. Flash the device — this writes the OS + CUDA + JetPack to the eMMC/NVMe
  5. Complete the Ubuntu first-run wizard on the Jetson (keyboard, timezone, user account)

  After this, you should be at a desktop or SSH prompt with JetPack installed. You can verify with cat /etc/nv_tegra_release — should show R36 with
  revision 5.0.

  ▎ r36.4 (JetPack 6.2/6.2.1) will work but the script warns about a CUDA memory allocation fix that shipped in r36.5.

  2. Install the NVMe drive

  If you're using an NVMe SSD (the project spec calls for 500GB):

  1. Power off the Jetson
  2. Install the M.2 NVMe drive in the M.2 slot (2230 or 2242 form factor depending on your carrier board)
  3. Boot back up — the drive should appear as /dev/nvme0n1
  4. You'll need to partition it if it's fresh. The script expects a data partition to exist (e.g., /dev/nvme0n1p4) — it encrypts that partition, not the
  whole disk

  Partition layout suggestion:
  /dev/nvme0n1p1  — boot/EFI (if booting from NVMe)
  /dev/nvme0n1p2  — rootfs
  /dev/nvme0n1p3  — swap (optional)
  /dev/nvme0n1p4  — data (this is what gets LUKS-encrypted)

  If JetPack was flashed to eMMC and the NVMe is purely for data, you could use a single partition /dev/nvme0n1p1 as the data partition.

  3. Clone the repo onto the Jetson

  git clone <your-repo-url> ~/mailbox
  cd ~/mailbox

  ---
  Running first-boot.sh

  sudo bash scripts/first-boot.sh

  The script is interactive — it pauses between each stage so you can review output. Here's what each stage does:

  Stage 1: Validate JetPack Version

  - Reads /etc/nv_tegra_release
  - Checks for R36 revision 4.0+
  - Aborts with SDK Manager link if version is wrong
  - You just press Enter if it says PASS

  Stage 2: Install Docker via JetsonHacks

  - Skips if Docker is already installed
  - Clones github.com/jetsonhacks/install-docker and runs install_nvidia_docker.sh
  - This installs Docker 27.5.1 with the NVIDIA runtime pre-configured
  - Important: It does NOT use apt-get install docker-ce — that breaks GPU passthrough on Jetson

  Stage 3: Verify GPU Passthrough

  - Runs docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi
  - You should see your Orin Nano Super GPU in the output
  - If it fails, it restarts the Docker daemon and retries once

  Stage 4: Set MAXN Power Mode

  - Queries nvpmodel for the MAXN mode ID (typically mode 0 on Orin Nano Super)
  - Sets it with nvpmodel -m 0
  - Creates a systemd service (/etc/systemd/system/set-maxn-power.service) so it persists across reboots
  - This unlocks the full 25W / 40 TOPS — JetPack 6.2's "Super Mode"

  Stage 5: LUKS Encrypt Data Partition

  This is the NVMe encryption stage. Here's exactly what happens:

  1. Installs cryptsetup-bin and tpm2-tools
  2. Checks for TPM device (/dev/tpm0 or /dev/tpmrm0) — warns if not found but continues
  3. Checks for /usr/sbin/gen_luks.sh (Jetson-native, ships with JetPack 6.2.2)
    - If missing, tries apt-get install nvidia-l4t-security-utils
    - If still missing, fails with guidance
  4. Shows you lsblk output of your NVMe partitions
  5. Prompts you to enter the partition (e.g., /dev/nvme0n1p4)
    - You can press Enter to skip (for dev/testing — not recommended for production)
  6. Asks you to type ENCRYPT to confirm — safety gate
  7. Runs gen_luks.sh <partition> — this uses Jetson's OP-TEE luks-srv Trusted Application to bind the LUKS key to the device's fTPM
  8. Verifies with cryptsetup luksDump

  What this means in practice: The NVMe data partition is encrypted at rest. The key is bound to the Jetson's TPM, so the device boots without a passphrase
   — but if someone pulls the NVMe out and puts it in another machine, the data is unreadable.

  Stage 6: Pre-pull Ollama Models

  - Pulls qwen3:4b (~2.7GB) and nomic-embed-text:v1.5 (~274MB) into a Docker named volume
  - Uses the Jetson-specific Ollama container image (dustynv/ollama:0.18.4-r36.4-cu126-22.04)
  - If jetson-containers autotag is available, it resolves the correct image for your JetPack version automatically
  - This takes a few minutes depending on your internet speed

  Stage 7: Start Docker Compose Stack

  - Copies .env.example to .env if no .env exists (warns you to change passwords)
  - Runs docker compose up -d --remove-orphans
  - Polls every 10s for all 5 services to be healthy, times out at 180s
  - Prints final docker compose ps status

  ---
  After first-boot completes

  Verify everything with the smoke test:

  bash scripts/smoke-test.sh           # Checks 1-5 (non-destructive)
  bash scripts/smoke-test.sh --boot-test  # Adds Check 6 (tears down and restarts stack)

  At this point your services are running on:
  - Postgres: internal only (no exposed port)
  - Qdrant: localhost:6333 (REST), localhost:6334 (gRPC)
  - Ollama: localhost:11434
  - n8n: localhost:5678
  - Dashboard: localhost:3000

  ---
  Key things to watch for

  ┌────────────────────────┬──────────────────────────┬───────────────────────────────────────────────────────────────┐
  │         Issue          │         Symptom          │                              Fix                              │
  ├────────────────────────┼──────────────────────────┼───────────────────────────────────────────────────────────────┤
  │ Wrong Docker install   │ GPU stage fails          │ Uninstall docker-ce, re-run JetsonHacks script                │
  ├────────────────────────┼──────────────────────────┼───────────────────────────────────────────────────────────────┤
  │ Qdrant crash loops     │ jemalloc errors in logs  │ Verify MALLOC_CONF=narenas:1 in compose                       │
  ├────────────────────────┼──────────────────────────┼───────────────────────────────────────────────────────────────┤
  │ Ollama can't see GPU   │ num_gpu: 0 in smoke test │ Ensure no mem_limit on ollama service                         │
  ├────────────────────────┼──────────────────────────┼───────────────────────────────────────────────────────────────┤
  │ gen_luks.sh missing    │ Stage 5 fails            │ Upgrade to JetPack 6.2.2 or install nvidia-l4t-security-utils │
  ├────────────────────────┼──────────────────────────┼───────────────────────────────────────────────────────────────┤
  │ Services slow to start │ Stage 7 timeout          │ First boot pulls layers; subsequent boots are faster. Retry.  │
  └────────────────────────┴──────────────────────────┴───────────────────────────────────────────────────────────────┘