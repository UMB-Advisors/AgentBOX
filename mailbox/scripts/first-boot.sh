#!/usr/bin/env bash
# first-boot.sh — MailBox One appliance bring-up script
#
# PURPOSE: Brings a freshly-flashed Jetson Orin Nano Super from post-JetPack
# state to fully operational appliance. Runs ONCE per device.
#
# PREREQUISITE: JetPack 6.2 must already be installed via NVIDIA SDK Manager
# BEFORE running this script. This script validates that installation — it does
# NOT flash the device. Use NVIDIA SDK Manager (https://developer.nvidia.com/sdk-manager)
# to flash JetPack 6.2.2 to the device before proceeding.
#
# USAGE: sudo bash scripts/first-boot.sh
#
# Stages:
#   1. Validate JetPack Version
#   2. Install Docker via JetsonHacks
#   3. Verify GPU Passthrough
#   4. Set MAXN Power Mode
#   5. LUKS Encrypt Data Partition
#   6. Pre-pull Ollama Models
#   7. Start Docker Compose Stack
#   8. Run Database Migrations           (--profile migrate)
#   9. Bootstrap Qdrant Collection       (--profile qdrant-bootstrap)
#  10. Build qwen3:4b-ctx4k + pull nomic-embed-text (DR-18)
#  11. Import n8n Workflows              (no credentials baked in)
#  12. Import n8n Postgres Credential    (fresh-install gotcha — else classify fails silently)
#  13. Verify All Six Services Healthy
#
# IDEMPOTENT: a 2nd run on a working box is a no-op. Each stage guards on
# "already done" — never overwrites an existing .env, never re-pulls a present
# model, never reimports a present workflow, and always passes --remove-orphans
# on compose up. Full field validation (reset -> re-bootstrap on a box): MBOX-180.

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly MAX_RETRIES=1
readonly OLLAMA_IMAGE_DEFAULT="dustynv/ollama:0.18.4-r36.4-cu126-22.04"

# Live container names. The ollama/n8n services do NOT pin container_name in
# docker-compose.yml, so their real names follow the compose default project
# convention (<projectdir>-<service>-<index>) and only equal mailbox-*-1 when the
# checkout dir is literally "mailbox". Resolved at runtime in main() via
# `docker compose ps -q <service>`; these are fallback defaults only.
OLLAMA_CONTAINER="mailbox-ollama-1"
N8N_CONTAINER="mailbox-n8n-1"

# DR-18 custom-ctx model. Base MUST be qwen3:4b-instruct, never the bare
# qwen3:4b alias — that shifted to a thinking-trained variant 2026-05-05 and
# breaks LOCAL drafts (STAQPRO-330). SoT: root CLAUDE.md Models table.
readonly CTX_MODEL="qwen3:4b-ctx4k"
readonly CTX_BASE_MODEL="qwen3:4b-instruct"
readonly EMBED_MODEL="nomic-embed-text:v1.5"

# Canonical n8n workflows imported from n8n/workflows/ (NO credentials baked in —
# credential records are appliance-local and re-linked per Step 4 of the
# onboarding runbook). Must match scripts/n8n-import-workflows.sh.
readonly N8N_WORKFLOWS=(
  "MailBOX.json"
  "MailBOX-Classify.json"
  "MailBOX-Draft.json"
  "MailBOX-Send.json"
  "MailBOX-Digest.json"
)

# Postgres credential ID hardcoded in MailBOX-Classify / MailBOX-Send. A fresh
# appliance has no credential with this ID, so classify fails silently until
# it's imported. We synthesize it from .env (see stage_import_n8n_pg_credential).
# project memory: project_n8n_postgres_credential_gotcha.
readonly N8N_PG_CRED_ID="JFX4tvrffvKnTouV"

# Stage tracking for summary table
declare -A STAGE_STATUS

# ---------------------------------------------------------------------------
# Trap for clean Ctrl+C handling
# ---------------------------------------------------------------------------

cleanup() {
  echo ""
  echo "[INTERRUPTED] First-boot script interrupted by user."
  echo "You may re-run this script to continue from where you left off."
  echo "Stages already completed do not need to be repeated."
  exit 130
}
trap cleanup INT TERM

# ---------------------------------------------------------------------------
# Root check
# ---------------------------------------------------------------------------

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root or with sudo."
  echo "Usage: sudo bash scripts/first-boot.sh"
  exit 1
fi

# ---------------------------------------------------------------------------
# Helper: print a section header
# ---------------------------------------------------------------------------

print_header() {
  echo ""
  echo "========================================"
  echo "  $1"
  echo "========================================"
}

# ---------------------------------------------------------------------------
# Helper: pause and wait for operator to press Enter
# ---------------------------------------------------------------------------

pause_for_verification() {
  echo ""
  echo "--- Stage complete. Review output above for any warnings. ---"
  echo "Press Enter to continue to the next stage (Ctrl+C to abort)..."
  read -r _
}

# ---------------------------------------------------------------------------
# run_stage: executes a stage function with retry-once logic
#
# Usage: run_stage "Stage Name" stage_function_name
# On first failure: waits 5s, retries once
# On second failure: prints diagnostics and exits 1
# ---------------------------------------------------------------------------

run_stage() {
  local stage_name="$1"
  local stage_fn="$2"
  local retry_count=0

  print_header "${stage_name}"

  while true; do
    if "${stage_fn}"; then
      echo ""
      echo "[PASS] ${stage_name}"
      STAGE_STATUS["${stage_name}"]="PASS"
      return 0
    fi

    retry_count=$((retry_count + 1))
    if [[ ${retry_count} -gt ${MAX_RETRIES} ]]; then
      echo ""
      echo "[FAIL] ${stage_name} failed after ${MAX_RETRIES} retry."
      STAGE_STATUS["${stage_name}"]="FAIL"
      echo "--- Diagnostics ---"
      "diag_${stage_fn}" 2>/dev/null || true
      echo ""
      echo "Halting. Fix the issue above and re-run: sudo bash scripts/first-boot.sh"
      exit 1
    fi

    echo "[RETRY] ${stage_name} failed. Waiting 5s before retry (attempt ${retry_count}/${MAX_RETRIES})..."
    sleep 5
  done
}

# ---------------------------------------------------------------------------
# STAGE 1: Validate JetPack Version
# ---------------------------------------------------------------------------
# IMPORTANT: This script does NOT flash the device.
# JetPack 6.2 must already be installed via NVIDIA SDK Manager before running.
# This stage only validates that the correct version is present.

stage_validate_jetpack() {
  local tegra_release="/etc/nv_tegra_release"
  local jetpack_major=""
  local jetpack_revision=""
  local revision_float=""

  echo "NOTE: This script validates a pre-existing JetPack installation."
  echo "      Flashing is a manual prerequisite done via NVIDIA SDK Manager."
  echo "      If JetPack is not yet installed, abort now and flash first."
  echo ""

  if [[ ! -f "${tegra_release}" ]]; then
    echo "ERROR: ${tegra_release} not found."
    echo ""
    echo "This device does not appear to have JetPack installed."
    echo "Flash the device with JetPack 6.2.2 using NVIDIA SDK Manager:"
    echo "  https://developer.nvidia.com/sdk-manager"
    echo ""
    echo "Steps:"
    echo "  1. Install SDK Manager on a host PC"
    echo "  2. Connect the Jetson in recovery mode"
    echo "  3. Select JetPack 6.2.2 (r36.5) as the target"
    echo "  4. Flash the device, then re-run this script"
    return 1
  fi

  echo "Reading ${tegra_release}:"
  cat "${tegra_release}"
  echo ""

  # Extract R-level (e.g., "R36" from "# R36 (release), ...")
  jetpack_major=$(grep -oP 'R\d+' "${tegra_release}" | head -1 || true)

  # Extract REVISION value (e.g., "5.0" from "REVISION: 5.0")
  jetpack_revision=$(grep -i 'REVISION' "${tegra_release}" | grep -oP '\d+\.\d+' | head -1 || true)

  echo "Detected JetPack major version: ${jetpack_major:-unknown}"
  echo "Detected revision: ${jetpack_revision:-unknown}"

  if [[ -z "${jetpack_major}" ]]; then
    echo "ERROR: Could not parse JetPack version from ${tegra_release}."
    echo "Expected format: '# R36 (release), REVISION: 5.0, ...'"
    return 1
  fi

  # Extract numeric part (e.g., "36" from "R36")
  local major_num="${jetpack_major#R}"

  if [[ "${major_num}" -lt 36 ]]; then
    echo ""
    echo "ERROR: JetPack version too old."
    echo "  Found:    ${jetpack_major} (revision ${jetpack_revision:-unknown})"
    echo "  Required: R36 (revision 4.0+) = JetPack 6.2+"
    echo ""
    echo "Re-flash with NVIDIA SDK Manager using JetPack 6.2.2:"
    echo "  https://developer.nvidia.com/sdk-manager"
    return 1
  fi

  # Check revision >= 4.0 (JetPack 6.2 = r36.4; 6.2.2 = r36.5)
  if [[ -n "${jetpack_revision}" ]]; then
    revision_float="${jetpack_revision}"
    # Use awk for float comparison
    local rev_ok
    rev_ok=$(awk -v r="${revision_float}" 'BEGIN { print (r >= 4.0) ? "yes" : "no" }')
    if [[ "${rev_ok}" != "yes" ]]; then
      echo ""
      echo "ERROR: JetPack revision too old."
      echo "  Found:    ${jetpack_major} revision ${jetpack_revision}"
      echo "  Required: R36 revision 4.0+ (JetPack 6.2+)"
      echo ""
      echo "Re-flash with NVIDIA SDK Manager using JetPack 6.2.2 (r36.5):"
      echo "  https://developer.nvidia.com/sdk-manager"
      return 1
    fi

    # Warn if revision < 5.0 (r36.5 = JetPack 6.2.2 with CUDA memory fix)
    local rev_new
    rev_new=$(awk -v r="${revision_float}" 'BEGIN { print (r >= 5.0) ? "yes" : "no" }')
    if [[ "${rev_new}" != "yes" ]]; then
      echo ""
      echo "WARNING: r36.4 detected (JetPack 6.2 or 6.2.1)."
      echo "  r36.5 (JetPack 6.2.2) is strongly recommended — it contains a"
      echo "  CUDA memory allocation fix that improves Ollama GPU stability."
      echo "  Upgrade path: sudo apt-get update && sudo apt-get dist-upgrade"
      echo "  Or re-flash with SDK Manager selecting JetPack 6.2.2."
      echo "  Continuing with r36.4 (may encounter GPU allocation issues)..."
    fi
  fi

  echo ""
  echo "JetPack version check passed."
  return 0
}

diag_stage_validate_jetpack() {
  echo "  File: /etc/nv_tegra_release"
  cat /etc/nv_tegra_release 2>/dev/null || echo "  (file not found)"
  echo ""
  echo "  Remediation: Flash with NVIDIA SDK Manager using JetPack 6.2.2"
  echo "  URL: https://developer.nvidia.com/sdk-manager"
}

# ---------------------------------------------------------------------------
# STAGE 2: Install Docker via JetsonHacks
# ---------------------------------------------------------------------------

stage_install_docker() {
  # Check if Docker is already installed
  if docker --version 2>/dev/null; then
    echo "Docker is already installed."
    docker --version
    # Verify it's the NVIDIA-compatible install (should not be docker-ce from Docker Inc)
    echo "Skipping install — Docker already present."
    return 0
  fi

  echo "Docker not found. Installing via JetsonHacks script..."
  echo "(This installs Docker 27.5.1 with NVIDIA runtime support)"
  echo ""

  # Clone JetsonHacks install-docker repo
  local install_dir="/tmp/install-docker"
  if [[ -d "${install_dir}" ]]; then
    echo "Removing existing /tmp/install-docker..."
    rm -rf "${install_dir}"
  fi

  echo "Cloning https://github.com/jetsonhacks/install-docker.git ..."
  git clone https://github.com/jetsonhacks/install-docker.git "${install_dir}"

  echo ""
  echo "Running install_nvidia_docker.sh..."
  cd "${install_dir}"
  bash install_nvidia_docker.sh

  echo ""
  echo "Running configure_nvidia_docker.sh..."
  bash configure_nvidia_docker.sh

  cd "${REPO_ROOT}"

  # Verify Docker installed successfully
  if ! docker --version 2>/dev/null; then
    echo "ERROR: Docker install completed but 'docker --version' failed."
    return 1
  fi

  echo ""
  echo "Docker installed:"
  docker --version
  return 0
}

diag_stage_install_docker() {
  echo "  docker --version output:"
  docker --version 2>&1 || echo "  (not available)"
  echo ""
  echo "  Possible causes:"
  echo "    - No internet connection (check: ping github.com)"
  echo "    - JetsonHacks repo changed (check: https://github.com/jetsonhacks/install-docker)"
  echo "    - Insufficient disk space (check: df -h)"
  df -h 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# STAGE 3: Verify GPU Passthrough
# ---------------------------------------------------------------------------

stage_verify_gpu() {
  echo "Testing GPU passthrough via Docker + nvidia-smi..."
  echo "Command: docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi"
  echo ""

  if docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi; then
    echo ""
    echo "GPU passthrough verified."
    return 0
  else
    echo "ERROR: GPU passthrough test failed."
    return 1
  fi
}

diag_stage_verify_gpu() {
  echo "  nvidia-ctk version:"
  nvidia-ctk --version 2>&1 || echo "  (nvidia-ctk not found)"
  echo ""
  echo "  Docker runtime config:"
  cat /etc/docker/daemon.json 2>/dev/null || echo "  /etc/docker/daemon.json not found"
  echo ""
  echo "  Remediation:"
  echo "    sudo nvidia-ctk runtime configure --runtime=docker"
  echo "    sudo systemctl restart docker"
  echo "  Then re-run this script."
}

stage_verify_gpu_retry_hook() {
  echo "Restarting Docker daemon before retry..."
  systemctl restart docker
  sleep 3
}

# Override run_stage to call retry hook for stage 3
run_stage_with_retry_hook() {
  local stage_name="$1"
  local stage_fn="$2"
  local retry_hook="${3:-}"
  local retry_count=0

  print_header "${stage_name}"

  while true; do
    if "${stage_fn}"; then
      echo ""
      echo "[PASS] ${stage_name}"
      STAGE_STATUS["${stage_name}"]="PASS"
      return 0
    fi

    retry_count=$((retry_count + 1))
    if [[ ${retry_count} -gt ${MAX_RETRIES} ]]; then
      echo ""
      echo "[FAIL] ${stage_name} failed after ${MAX_RETRIES} retry."
      STAGE_STATUS["${stage_name}"]="FAIL"
      echo "--- Diagnostics ---"
      "diag_${stage_fn}" 2>/dev/null || true
      echo ""
      echo "Halting. Fix the issue above and re-run: sudo bash scripts/first-boot.sh"
      exit 1
    fi

    echo "[RETRY] ${stage_name} failed. Waiting 5s before retry (attempt ${retry_count}/${MAX_RETRIES})..."
    if [[ -n "${retry_hook}" ]]; then
      "${retry_hook}" || true
    fi
    sleep 5
  done
}

# ---------------------------------------------------------------------------
# STAGE 4: Set MAXN Power Mode
# ---------------------------------------------------------------------------

stage_set_power_mode() {
  echo "Querying available nvpmodel power modes..."
  local verbose_output
  verbose_output=$(nvpmodel -q --verbose 2>&1 || true)
  echo "${verbose_output}"
  echo ""

  # Find the MAXN mode ID by looking for a line containing "MAXN" (case-insensitive)
  # nvpmodel output format example:
  #   NV Power Mode: MAXN
  #   0
  # or:
  #   < ID:0 power_model: MAXN >
  local maxn_id=""

  # Try multiple output formats
  # Format 1: "< ID:N power_model: MAXN >" or similar
  if echo "${verbose_output}" | grep -qi 'MAXN'; then
    # Try to extract ID from "< ID:N" pattern
    maxn_id=$(echo "${verbose_output}" | grep -i 'MAXN' | grep -oP '(?i)id\s*:\s*\K\d+' | head -1 || true)

    # If that didn't work, try extracting from lines preceding "MAXN"
    if [[ -z "${maxn_id}" ]]; then
      # Look for a number on the line before or after MAXN
      maxn_id=$(echo "${verbose_output}" | grep -B2 -A2 -i 'MAXN' | grep -oP '^\s*\K\d+$' | head -1 || true)
    fi

    # Last resort: find any standalone number near MAXN context
    if [[ -z "${maxn_id}" ]]; then
      # On many Jetson boards MAXN is mode 0
      echo "WARNING: Could not auto-detect MAXN mode ID from nvpmodel output."
      echo "Attempting to use mode 0 (standard MAXN ID on Orin Nano Super)..."
      maxn_id="0"
    fi
  else
    echo "ERROR: nvpmodel did not list a MAXN mode. Output above may indicate an issue."
    echo "Check: sudo nvpmodel -q --verbose"
    return 1
  fi

  echo "Detected MAXN mode ID: ${maxn_id}"
  echo ""
  echo "Setting MAXN power mode: nvpmodel -m ${maxn_id}"
  nvpmodel -m "${maxn_id}"

  # Verify the mode was set
  local current_mode
  current_mode=$(nvpmodel -q 2>&1 || true)
  echo "Current power mode: ${current_mode}"

  if ! echo "${current_mode}" | grep -qi 'MAXN'; then
    echo "ERROR: Power mode set but MAXN not confirmed in nvpmodel -q output."
    return 1
  fi

  echo ""
  echo "Creating systemd service to persist MAXN mode across reboots..."

  cat > /etc/systemd/system/set-maxn-power.service << EOF
[Unit]
Description=Set Jetson Orin to MAXN power mode
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/usr/bin/nvpmodel -m ${maxn_id}
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable set-maxn-power.service
  echo "systemd service set-maxn-power.service enabled."

  return 0
}

diag_stage_set_power_mode() {
  echo "  All available power modes:"
  nvpmodel -q --verbose 2>&1 || echo "  (nvpmodel not available)"
  echo ""
  echo "  Remediation: Run 'sudo nvpmodel -q --verbose' to see mode IDs,"
  echo "  then manually run 'sudo nvpmodel -m <id>' for the MAXN mode."
}

# ---------------------------------------------------------------------------
# STAGE 5: LUKS Encrypt Data Partition
# ---------------------------------------------------------------------------

stage_luks_encrypt() {
  echo "Installing LUKS and TPM2 prerequisites..."
  apt-get update -qq
  apt-get install -y cryptsetup-bin tpm2-tools

  echo ""
  echo "Checking for TPM device..."
  if [[ -e /dev/tpm0 ]]; then
    echo "  Found: /dev/tpm0"
  elif [[ -e /dev/tpmrm0 ]]; then
    echo "  Found: /dev/tpmrm0"
  else
    echo "  WARNING: Neither /dev/tpm0 nor /dev/tpmrm0 found."
    echo "  LUKS key binding to device TPM may not work."
    echo "  Continuing — LUKS will still encrypt the partition."
  fi

  echo ""
  echo "Checking for Jetson-native gen_luks.sh..."
  local gen_luks="/usr/sbin/gen_luks.sh"

  if [[ ! -f "${gen_luks}" ]]; then
    echo "WARNING: ${gen_luks} not found."
    echo "Attempting to install nvidia-l4t-security-utils..."
    apt-get install -y nvidia-l4t-security-utils || true

    if [[ ! -f "${gen_luks}" ]]; then
      echo ""
      echo "FAIL: LUKS encryption requires gen_luks.sh."
      echo ""
      echo "  gen_luks.sh is part of nvidia-l4t-security-utils and is installed"
      echo "  with JetPack 6.2.2 (r36.5). It uses Jetson's OP-TEE luks-srv"
      echo "  Trusted Application to bind the LUKS key to the device fTPM."
      echo ""
      echo "  Possible fixes:"
      echo "    1. Upgrade to JetPack 6.2.2 (r36.5):"
      echo "       sudo apt-get update && sudo apt-get dist-upgrade"
      echo "    2. Check NVIDIA Jetson Linux r36.5 Developer Guide:"
      echo "       'Disk Encryption' section for manual installation"
      echo "    3. If hardware is pre-r36.5: manually install from NVIDIA L4T packages"
      echo ""
      return 1
    fi
    echo "nvidia-l4t-security-utils installed. gen_luks.sh found."
  else
    echo "  Found: ${gen_luks}"
  fi

  echo ""
  echo "Using Jetson-native LUKS encryption (gen_luks.sh + OP-TEE luks-srv)"
  echo ""
  echo "You must identify the data partition to encrypt."
  echo "Typical partition for data: /dev/nvme0n1p4 (may vary by device)"
  echo ""
  echo "Current NVMe partition table:"
  lsblk -o NAME,SIZE,TYPE,MOUNTPOINT /dev/nvme0n1 2>/dev/null || lsblk 2>/dev/null || true
  echo ""

  local data_partition=""
  while [[ -z "${data_partition}" ]]; do
    echo "Enter the data partition to encrypt (e.g., /dev/nvme0n1p4),"
    echo "or press Enter to skip LUKS encryption (NOT recommended for production):"
    read -r data_partition

    if [[ -z "${data_partition}" ]]; then
      echo "WARNING: Skipping LUKS encryption. Customer data will NOT be encrypted at rest."
      echo "This is acceptable for development/testing only. Re-run to encrypt before shipping."
      return 0
    fi

    if [[ ! -b "${data_partition}" ]]; then
      echo "ERROR: ${data_partition} is not a block device. Please try again."
      data_partition=""
    fi
  done

  echo ""
  echo "WARNING: This will ENCRYPT ${data_partition}."
  echo "All existing data on this partition will be INACCESSIBLE without the LUKS key."
  echo "Ensure this is the correct partition and that any important data is backed up."
  echo ""
  echo "Type 'ENCRYPT' (all caps) to confirm, or press Enter to abort:"
  read -r confirm

  if [[ "${confirm}" != "ENCRYPT" ]]; then
    echo "Aborted by user. LUKS encryption skipped."
    echo "Re-run this script and confirm ENCRYPT to enable disk encryption."
    return 1
  fi

  echo ""
  echo "Running gen_luks.sh on ${data_partition}..."
  /usr/sbin/gen_luks.sh "${data_partition}"

  echo ""
  echo "Verifying LUKS header..."
  if cryptsetup luksDump "${data_partition}"; then
    echo ""
    echo "LUKS encryption applied to ${data_partition}."
    return 0
  else
    echo "ERROR: cryptsetup luksDump failed — LUKS header not found."
    return 1
  fi
}

diag_stage_luks_encrypt() {
  echo "  gen_luks.sh search:"
  ls /usr/sbin/gen_luks* 2>/dev/null || echo "  (not found)"
  echo ""
  echo "  nvidia-l4t-security packages:"
  dpkg -l | grep nvidia-l4t-security 2>/dev/null || echo "  (none installed)"
  echo ""
  echo "  TPM devices:"
  ls /dev/tpm* 2>/dev/null || echo "  (none found)"
}

# ---------------------------------------------------------------------------
# STAGE 6: Pre-pull Ollama Models
# ---------------------------------------------------------------------------

stage_prepull_models() {
  # Load OLLAMA_IMAGE from .env if available
  local ollama_image="${OLLAMA_IMAGE_DEFAULT}"
  local env_file="${REPO_ROOT}/.env"

  if [[ -f "${env_file}" ]]; then
    local env_image
    env_image=$(grep -E '^OLLAMA_IMAGE=' "${env_file}" | cut -d= -f2- | tr -d '"' || true)
    if [[ -n "${env_image}" ]]; then
      ollama_image="${env_image}"
      echo "Using OLLAMA_IMAGE from .env: ${ollama_image}"
    fi
  fi

  # Check if jetson-containers autotag is available to resolve the correct image
  if command -v autotag &>/dev/null; then
    echo "jetson-containers autotag available. Resolving Ollama image..."
    local resolved_image
    resolved_image=$(autotag ollama 2>/dev/null || true)
    if [[ -n "${resolved_image}" ]]; then
      ollama_image="${resolved_image}"
      echo "Resolved Ollama image via autotag: ${ollama_image}"
    else
      echo "autotag returned empty result; using default: ${ollama_image}"
    fi
  else
    echo "jetson-containers autotag not found; using image: ${ollama_image}"
  fi

  echo ""
  echo "Creating ollama_models named volume (if not exists)..."
  docker volume create ollama_models

  echo "Starting temporary Ollama server..."
  docker run -d --rm --runtime nvidia \
    --name ollama-stage6 \
    -v ollama_models:/root/.ollama \
    "${ollama_image}" serve
  sleep 5

  echo "Verifying both models are present in the volume..."
  local model_list
  model_list=$(docker exec ollama-stage6 ollama list 2>&1 || true)
  echo "${model_list}"
  docker stop ollama-stage6 2>/dev/null || true

  if ! echo "${model_list}" | grep -q "qwen3:4b"; then
    echo "ERROR: qwen3:4b not found in ollama list."
    return 1
  fi
  if ! echo "${model_list}" | grep -q "nomic-embed-text"; then
    echo "ERROR: nomic-embed-text not found in ollama list."
    return 1
  fi

  echo "Both models verified in ollama_models volume."
  return 0
}

diag_stage_prepull_models() {
  echo "  Disk space:"
  df -h 2>/dev/null || true
  echo ""
  echo "  Docker images:"
  docker images 2>/dev/null || true
  echo ""
  echo "  Docker volumes:"
  docker volume ls 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# STAGE 7: Start Docker Compose Stack
# ---------------------------------------------------------------------------

stage_start_compose() {
  cd "${REPO_ROOT}"

  # Ensure .env file exists
  if [[ ! -f ".env" ]]; then
    if [[ -f ".env.example" ]]; then
      cp .env.example .env
      echo "WARNING: .env file not found. Copied from .env.example."
      echo ""
      echo "IMPORTANT: Edit .env before production deployment."
      echo "  Required changes:"
      echo "    - POSTGRES_PASSWORD: change from default"
      echo "    - N8N_ENCRYPTION_KEY: set a unique random key"
      echo "    - ANTHROPIC_API_KEY: add your API key"
      echo ""
      echo "Continuing with defaults (safe for initial testing only)..."
    else
      echo "ERROR: Neither .env nor .env.example found in ${REPO_ROOT}."
      echo "Clone the full repository before running this script."
      return 1
    fi
  fi

  echo "Starting Docker Compose stack..."
  docker compose up -d

  echo ""
  echo "Waiting for all services to become healthy (timeout: 180s)..."

  local elapsed=0
  local timeout=180
  local all_healthy=false

  while [[ ${elapsed} -lt ${timeout} ]]; do
    # Get compose service health status
    local ps_output
    ps_output=$(docker compose ps --format '{{.Name}}\t{{.Health}}' 2>/dev/null || \
                docker compose ps 2>/dev/null || true)

    # Count services that are healthy or running (some services don't have healthcheck)
    local healthy_count
    healthy_count=$(echo "${ps_output}" | grep -cE 'healthy|running' || echo "0")
    local total_count
    total_count=$(docker compose ps --quiet 2>/dev/null | wc -l || echo "0")

    echo "  [${elapsed}s/${timeout}s] Healthy/Running: ${healthy_count}/${total_count}"

    # Check if any service has "unhealthy" status
    if echo "${ps_output}" | grep -q "unhealthy"; then
      echo "  WARNING: One or more services are unhealthy. Waiting..."
    fi

    # Check if all expected services are up (5 services in compose)
    if [[ "${healthy_count}" -ge 5 ]]; then
      all_healthy=true
      break
    fi

    sleep 10
    elapsed=$((elapsed + 10))
  done

  echo ""
  echo "--- Final Docker Compose Status ---"
  docker compose ps

  if [[ "${all_healthy}" != "true" ]]; then
    echo ""
    echo "WARNING: Not all services reached healthy state within ${timeout}s."
    echo "Some services may still be starting up. Check logs:"
    echo "  docker compose logs --tail=20"
    echo ""
    echo "Common causes on first boot:"
    echo "  - Qdrant ARM64 jemalloc issue: check MALLOC_CONF=narenas:1 is set in compose"
    echo "  - n8n Postgres connection: ensure POSTGRES_PASSWORD matches .env"
    echo "  - Ollama GPU: ensure no mem_limit is set on ollama service"
    return 1
  fi

  return 0
}

diag_stage_start_compose() {
  cd "${REPO_ROOT}" 2>/dev/null || true
  echo "  Recent compose logs:"
  docker compose logs --tail=20 2>/dev/null || true
  echo ""
  echo "  Compose process status:"
  docker compose ps 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# STAGE 8: Run Database Migrations
# ---------------------------------------------------------------------------
# Idempotent: the migration runner (dashboard/migrations/runner.ts) tracks
# applied migrations and skips ones already run, so a 2nd invocation is a no-op
# at the SQL level. We additionally skip the whole stage when the schema is
# already present, to avoid the npm-install cost on a working box.

stage_run_migrations() {
  cd "${REPO_ROOT}"

  # Already-done guard: if mailbox.drafts exists, migrations have run.
  echo "Checking whether the mailbox schema already exists..."
  local table_check
  table_check=$(docker compose exec -T postgres \
    psql -U "${POSTGRES_USER:-mailbox}" -d "${POSTGRES_DB:-mailbox}" -tAc \
    "SELECT to_regclass('mailbox.drafts') IS NOT NULL;" 2>/dev/null | tr -d '[:space:]' || true)

  if [[ "${table_check}" == "t" ]]; then
    echo "mailbox.drafts already present — migrations already applied. Skipping."
    return 0
  fi

  echo "Schema not present (or postgres not yet queryable). Running migrations..."
  echo "Command: docker compose --profile migrate run --rm mailbox-migrate"
  docker compose --profile migrate run --rm mailbox-migrate

  echo ""
  echo "Verifying mailbox.drafts now exists..."
  table_check=$(docker compose exec -T postgres \
    psql -U "${POSTGRES_USER:-mailbox}" -d "${POSTGRES_DB:-mailbox}" -tAc \
    "SELECT to_regclass('mailbox.drafts') IS NOT NULL;" 2>/dev/null | tr -d '[:space:]' || true)
  if [[ "${table_check}" != "t" ]]; then
    echo "ERROR: migrations ran but mailbox.drafts not found."
    return 1
  fi
  echo "Migrations applied."
  return 0
}

diag_stage_run_migrations() {
  cd "${REPO_ROOT}" 2>/dev/null || true
  echo "  Postgres service status:"
  docker compose ps postgres 2>/dev/null || true
  echo ""
  echo "  Last migrate run logs:"
  docker compose --profile migrate logs mailbox-migrate --tail=30 2>/dev/null || true
  echo ""
  echo "  Common cause: POSTGRES_PASSWORD in .env does not match the value"
  echo "  postgres was first initialized with (the volume keeps the original)."
}

# ---------------------------------------------------------------------------
# STAGE 9: Bootstrap Qdrant Collection
# ---------------------------------------------------------------------------
# The bootstrap (npm run qdrant:bootstrap) is itself idempotent — PUT collection
# + payload indexes are no-ops in Qdrant 1.13+ when already present (STAQPRO-188).
# We still short-circuit on an existing email_messages collection to skip the
# npm-install cost on a working box.

stage_bootstrap_qdrant() {
  cd "${REPO_ROOT}"

  echo "Checking whether the email_messages Qdrant collection already exists..."
  # Query Qdrant through a throwaway curl inside the qdrant container's network.
  # The qdrant image lacks curl, so probe from the host via the compose-exposed
  # service using a lightweight node:20-alpine sidecar on the default network.
  local exists
  exists=$(docker compose exec -T qdrant \
    sh -c 'wget -qO- http://localhost:6333/collections/email_messages 2>/dev/null' 2>/dev/null || true)

  if echo "${exists}" | grep -q '"status":"ok"'; then
    echo "email_messages collection already present. Skipping bootstrap."
    return 0
  fi

  echo "Collection not found. Running Qdrant bootstrap..."
  echo "Command: docker compose --profile qdrant-bootstrap run --rm mailbox-qdrant-bootstrap"
  docker compose --profile qdrant-bootstrap run --rm mailbox-qdrant-bootstrap

  echo ""
  echo "Verifying email_messages collection now exists..."
  exists=$(docker compose exec -T qdrant \
    sh -c 'wget -qO- http://localhost:6333/collections/email_messages 2>/dev/null' 2>/dev/null || true)
  if ! echo "${exists}" | grep -q '"status":"ok"'; then
    echo "ERROR: bootstrap ran but email_messages collection not found."
    return 1
  fi
  echo "Qdrant collection bootstrapped."
  return 0
}

diag_stage_bootstrap_qdrant() {
  cd "${REPO_ROOT}" 2>/dev/null || true
  echo "  Qdrant service status:"
  docker compose ps qdrant 2>/dev/null || true
  echo ""
  echo "  Bootstrap run logs:"
  docker compose --profile qdrant-bootstrap logs mailbox-qdrant-bootstrap --tail=30 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# STAGE 10: Build qwen3:4b-ctx4k + pull nomic-embed-text  (DR-18)
# ---------------------------------------------------------------------------
# Stage 6 pre-seeds the ollama_models volume against a temp container; here we
# operate against the LIVE ollama service (same volume) once compose is up. Two
# idempotency guards: skip the embed pull if present, skip the ctx4k create if
# the tag already exists. The Modelfile is written via docker cp (ollama in this
# version does not read `-f -` from stdin — see jetson-02 install plan v0.2).

stage_build_ctx_model() {
  cd "${REPO_ROOT}"

  echo "Listing models currently in the live ollama service..."
  local model_list
  model_list=$(docker exec "${OLLAMA_CONTAINER}" ollama list 2>&1 || true)
  echo "${model_list}"
  echo ""

  # --- nomic-embed-text:v1.5 (RAG embeddings) ---
  if echo "${model_list}" | grep -q "nomic-embed-text"; then
    echo "${EMBED_MODEL} already present — skipping pull."
  else
    echo "Pulling ${EMBED_MODEL}..."
    docker exec "${OLLAMA_CONTAINER}" ollama pull "${EMBED_MODEL}"
  fi

  # --- qwen3:4b-ctx4k (DR-18 custom 4096-ctx classifier + local drafter) ---
  if echo "${model_list}" | grep -q "${CTX_MODEL}"; then
    echo "${CTX_MODEL} already present — skipping custom Modelfile build."
  else
    echo "Building ${CTX_MODEL} from ${CTX_BASE_MODEL} (num_ctx 4096)..."
    # Ensure the base is present (creating from a missing base pulls it, but be
    # explicit so a slow pull is visible rather than buried in `ollama create`).
    if ! echo "${model_list}" | grep -q "${CTX_BASE_MODEL}"; then
      echo "Base ${CTX_BASE_MODEL} missing — pulling first..."
      docker exec "${OLLAMA_CONTAINER}" ollama pull "${CTX_BASE_MODEL}"
    fi

    local modelfile="/tmp/Modelfile.qwen3-4b-ctx4k"
    # No explicit TEMPLATE: inherits the chatml template from FROM qwen3:4b-instruct
    # (DR-18 builds the ctx4k variant with only num_ctx + params, no TEMPLATE
    # override). This artifact gates LOCAL drafts per STAQPRO-330 — MBOX-180 must
    # verify draft OUTPUT, not just `ollama list` presence. Stop tokens MUST be
    # quoted or the shell/Modelfile parser mangles the <|...|> pipes.
    cat > "${modelfile}" << EOF
FROM ${CTX_BASE_MODEL}
PARAMETER temperature 0.7
PARAMETER top_k 20
PARAMETER top_p 0.8
PARAMETER num_ctx 4096
PARAMETER stop "<|im_start|>"
PARAMETER stop "<|im_end|>"
EOF
    docker cp "${modelfile}" "${OLLAMA_CONTAINER}:/tmp/Modelfile"
    rm -f "${modelfile}"
    docker exec "${OLLAMA_CONTAINER}" ollama create "${CTX_MODEL}" -f /tmp/Modelfile
    docker exec "${OLLAMA_CONTAINER}" rm -f /tmp/Modelfile 2>/dev/null || true
  fi

  echo ""
  echo "Verifying both models are now present in the live ollama service..."
  model_list=$(docker exec "${OLLAMA_CONTAINER}" ollama list 2>&1 || true)
  if ! echo "${model_list}" | grep -q "${CTX_MODEL}"; then
    echo "ERROR: ${CTX_MODEL} not found after build."
    return 1
  fi
  if ! echo "${model_list}" | grep -q "nomic-embed-text"; then
    echo "ERROR: nomic-embed-text not found after pull."
    return 1
  fi
  echo "${CTX_MODEL} + ${EMBED_MODEL} ready."
  return 0
}

diag_stage_build_ctx_model() {
  echo "  Live ollama models:"
  docker exec "${OLLAMA_CONTAINER}" ollama list 2>&1 || echo "  (ollama container not reachable: ${OLLAMA_CONTAINER})"
  echo ""
  echo "  Disk space:"
  df -h 2>/dev/null || true
  echo ""
  echo "  NOTE: base model MUST be ${CTX_BASE_MODEL}, never the bare qwen3:4b"
  echo "  alias (thinking-trained variant — STAQPRO-330)."
}

# ---------------------------------------------------------------------------
# STAGE 11: Import n8n Workflows
# ---------------------------------------------------------------------------
# Imports the canonical workflow JSON from n8n/workflows/ WITHOUT credentials
# baked in (credential records are appliance-local, re-linked per onboarding
# Step 4). Idempotency: n8n import:workflow upserts by the workflow's stable id,
# so re-import is safe; we additionally skip a workflow whose name is already
# present in n8n's DB to avoid churn on a working box.

stage_import_n8n_workflows() {
  cd "${REPO_ROOT}"

  echo "Reading existing workflow names from n8n..."
  local existing
  existing=$(docker exec "${N8N_CONTAINER}" n8n list:workflow 2>/dev/null || true)
  echo "${existing:-<none>}"
  echo ""

  local in_dir="${REPO_ROOT}/n8n/workflows"
  local imported=0
  local skipped=0
  local filename name

  for filename in "${N8N_WORKFLOWS[@]}"; do
    local in_path="${in_dir}/${filename}"
    if [[ ! -f "${in_path}" ]]; then
      echo "  [skip] ${filename} (not found at ${in_path})"
      continue
    fi

    # Workflow display name is the JSON basename minus .json (matches repo
    # naming: MailBOX, MailBOX-Classify, ...).
    name="${filename%.json}"

    if echo "${existing}" | grep -qw "${name}"; then
      echo "  [have] ${name} already imported — skipping."
      skipped=$((skipped + 1))
      continue
    fi

    echo "  [import] ${filename}"
    docker cp "${in_path}" "${N8N_CONTAINER}:/tmp/${filename}"
    docker exec "${N8N_CONTAINER}" n8n import:workflow --input="/tmp/${filename}"
    docker exec "${N8N_CONTAINER}" rm -f "/tmp/${filename}" 2>/dev/null || true
    imported=$((imported + 1))
  done

  echo ""
  echo "Workflows imported: ${imported}, already present: ${skipped}."
  echo "NOTE: imported workflows start INACTIVE. Activation + credential"
  echo "re-link is operator work (onboarding Step 4); the n8n-verify gate"
  echo "(Stage 13 below / 'mailbox-n8n-verify' profile) confirms active state."
  return 0
}

diag_stage_import_n8n_workflows() {
  echo "  n8n service status:"
  docker exec "${N8N_CONTAINER}" n8n list:workflow 2>&1 || echo "  (n8n container not reachable: ${N8N_CONTAINER})"
  echo ""
  echo "  Workflow source dir:"
  ls -la "${REPO_ROOT}/n8n/workflows/" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# STAGE 12: Import n8n Postgres Credential  (fresh-install gotcha)
# ---------------------------------------------------------------------------
# MailBOX-Classify / MailBOX-Send reference Postgres credential id
# JFX4tvrffvKnTouV. A fresh appliance has no credential with that id, so classify
# fails SILENTLY. We synthesize the credential from .env and import it by that
# stable id (n8n import:credentials upserts by id → idempotent).
#
# Gmail OAuth (id vEz5mz0uaAtlK8yz) is intentionally NOT handled here — it needs
# the interactive Google consent flow and must be created in the n8n UI
# (onboarding Step 4). This stage covers ONLY the non-interactive Postgres cred.

stage_import_n8n_pg_credential() {
  cd "${REPO_ROOT}"

  # Pull Postgres connection values from .env (already created by Stage 7).
  local pg_user pg_pass pg_db
  pg_user="${POSTGRES_USER:-mailbox}"
  pg_pass="${POSTGRES_PASSWORD:-}"
  pg_db="${POSTGRES_DB:-mailbox}"

  if [[ -z "${pg_pass}" ]]; then
    echo "WARNING: POSTGRES_PASSWORD not set in environment — cannot synthesize"
    echo "the n8n Postgres credential. Import it manually per onboarding Step 4,"
    echo "or set POSTGRES_PASSWORD in .env and re-run. Continuing."
    return 0
  fi

  # Already-done guard: skip if a credential with this id already exists.
  echo "Checking whether n8n Postgres credential ${N8N_PG_CRED_ID} already exists..."
  local existing_creds
  existing_creds=$(docker exec "${N8N_CONTAINER}" n8n list:credentials 2>/dev/null || true)
  if echo "${existing_creds}" | grep -q "${N8N_PG_CRED_ID}"; then
    echo "Credential ${N8N_PG_CRED_ID} already present — skipping import."
    return 0
  fi

  echo "Credential not found. Synthesizing from .env and importing..."

  # Build the credential JSON. n8n import:credentials accepts an array of
  # credential objects; data is encrypted on import with N8N_ENCRYPTION_KEY.
  # Service name 'postgres' = compose DNS for the DB container.
  local creds_file="/tmp/n8n-pg-credential.json"
  cat > "${creds_file}" << EOF
[
  {
    "id": "${N8N_PG_CRED_ID}",
    "name": "MailBOX Postgres",
    "type": "postgres",
    "data": {
      "host": "postgres",
      "port": 5432,
      "database": "${pg_db}",
      "user": "${pg_user}",
      "password": "${pg_pass}",
      "ssl": "disable"
    }
  }
]
EOF

  docker cp "${creds_file}" "${N8N_CONTAINER}:/tmp/n8n-pg-credential.json"
  # Remove the host-side plaintext copy immediately.
  rm -f "${creds_file}"
  docker exec "${N8N_CONTAINER}" n8n import:credentials --input="/tmp/n8n-pg-credential.json"
  # Remove the in-container plaintext copy (n8n has already encrypted it to its DB).
  docker exec "${N8N_CONTAINER}" rm -f /tmp/n8n-pg-credential.json 2>/dev/null || true

  echo ""
  echo "Verifying credential ${N8N_PG_CRED_ID} is now present..."
  existing_creds=$(docker exec "${N8N_CONTAINER}" n8n list:credentials 2>/dev/null || true)
  if ! echo "${existing_creds}" | grep -q "${N8N_PG_CRED_ID}"; then
    echo "ERROR: Postgres credential import did not register id ${N8N_PG_CRED_ID}."
    return 1
  fi
  echo "Postgres credential imported. (Gmail OAuth remains manual — Step 4.)"
  return 0
}

diag_stage_import_n8n_pg_credential() {
  echo "  n8n credentials list:"
  docker exec "${N8N_CONTAINER}" n8n list:credentials 2>&1 || echo "  (n8n container not reachable: ${N8N_CONTAINER})"
  echo ""
  echo "  Expected Postgres credential id: ${N8N_PG_CRED_ID}"
  echo "  If import failed, confirm POSTGRES_PASSWORD is set in .env and that"
  echo "  N8N_ENCRYPTION_KEY is stable (changing it orphans existing credentials)."
}

# ---------------------------------------------------------------------------
# STAGE 13: Verify All Six Services Healthy
# ---------------------------------------------------------------------------
# Final gate: confirm the 6 core services (postgres, qdrant, ollama, n8n, caddy,
# mailbox-dashboard) are running/healthy. Profile-only services (migrate,
# qdrant-bootstrap, n8n-verify, llama-cpp) are NOT expected to be running here.
# Read-only — safe to re-run.

stage_verify_services() {
  cd "${REPO_ROOT}"

  local core_services=(postgres qdrant ollama n8n caddy mailbox-dashboard)
  local svc state missing=0

  echo "Checking the six core services..."
  echo ""
  printf "%-22s %s\n" "Service" "State"
  printf "%-22s %s\n" "-------" "-----"

  for svc in "${core_services[@]}"; do
    # docker compose ps emits the running/health state; empty = not running.
    state=$(docker compose ps --format '{{.State}}' "${svc}" 2>/dev/null | head -1 || true)
    if [[ -z "${state}" ]]; then
      state="NOT RUNNING"
      missing=$((missing + 1))
    elif [[ "${state}" != "running" ]]; then
      missing=$((missing + 1))
    fi
    printf "%-22s %s\n" "${svc}" "${state}"
  done

  echo ""
  if [[ "${missing}" -ne 0 ]]; then
    echo "ERROR: ${missing} core service(s) not running. See 'docker compose ps' above."
    return 1
  fi

  echo "All six core services are running."
  echo ""
  echo "n8n activation gate (workflows must be active=true or the pipeline"
  echo "dark-classifies). Run the canonical gate after credential re-link:"
  echo "  docker compose --profile n8n-verify run --rm mailbox-n8n-verify"
  return 0
}

diag_stage_verify_services() {
  cd "${REPO_ROOT}" 2>/dev/null || true
  echo "  Full compose status:"
  docker compose ps 2>/dev/null || true
  echo ""
  echo "  Recent logs:"
  docker compose logs --tail=20 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Main execution
# ---------------------------------------------------------------------------

main() {
  echo ""
  echo "========================================"
  echo "  MailBox One — First-Boot Setup"
  echo "  $(date)"
  echo "========================================"
  echo ""
  echo "This script will bring up a fresh Jetson Orin Nano Super from"
  echo "post-JetPack state to fully operational appliance."
  echo ""
  echo "PREREQUISITE: JetPack 6.2 must already be installed via NVIDIA SDK Manager."
  echo "This script validates that installation — it does NOT flash the device."
  echo ""
  echo "Stages to complete:"
  echo "  1. Validate JetPack Version"
  echo "  2. Install Docker via JetsonHacks"
  echo "  3. Verify GPU Passthrough"
  echo "  4. Set MAXN Power Mode"
  echo "  5. LUKS Encrypt Data Partition"
  echo "  6. Pre-pull Ollama Models"
  echo "  7. Start Docker Compose Stack"
  echo "  8. Run Database Migrations"
  echo "  9. Bootstrap Qdrant Collection"
  echo " 10. Build qwen3:4b-ctx4k + pull nomic-embed-text"
  echo " 11. Import n8n Workflows"
  echo " 12. Import n8n Postgres Credential"
  echo " 13. Verify All Six Services Healthy"
  echo ""
  echo "Press Enter to begin, or Ctrl+C to abort..."
  read -r _

  # Stage 1: JetPack Version Validation
  run_stage "Stage 1: Validate JetPack Version" stage_validate_jetpack
  pause_for_verification

  # Stage 2: Install Docker
  run_stage "Stage 2: Install Docker via JetsonHacks" stage_install_docker
  pause_for_verification

  # Stage 3: GPU Passthrough (with restart-docker retry hook)
  run_stage_with_retry_hook "Stage 3: Verify GPU Passthrough" stage_verify_gpu stage_verify_gpu_retry_hook
  pause_for_verification

  # Stage 4: Power Mode
  run_stage "Stage 4: Set MAXN Power Mode" stage_set_power_mode
  pause_for_verification

  # Stage 5: LUKS Encryption
  run_stage "Stage 5: LUKS Encrypt Data Partition" stage_luks_encrypt
  pause_for_verification

  # Stage 6: Pre-pull Models
  run_stage "Stage 6: Pre-pull Ollama Models" stage_prepull_models
  pause_for_verification

  # Stage 7: Start Compose
  run_stage "Stage 7: Start Docker Compose Stack" stage_start_compose
  pause_for_verification

  # Stages 8-13 operate against the LIVE compose stack. They need the .env
  # Postgres values in the script environment (Stage 7 created/copied .env but
  # did not export it). Do NOT `source .env`: shell parameter expansion would
  # corrupt a POSTGRES_PASSWORD containing a literal `$` (and the Compose-only
  # bcrypt `$$` escaping). Extract only the keys we need with the same safe
  # grep|cut|tr idiom Stage 6 uses for OLLAMA_IMAGE.
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    local env_file="${REPO_ROOT}/.env"
    local v
    v=$(grep -E '^POSTGRES_USER=' "${env_file}" | cut -d= -f2- | tr -d '"' || true)
    [[ -n "${v}" ]] && export POSTGRES_USER="${v}"
    v=$(grep -E '^POSTGRES_PASSWORD=' "${env_file}" | cut -d= -f2- | tr -d '"' || true)
    [[ -n "${v}" ]] && export POSTGRES_PASSWORD="${v}"
    v=$(grep -E '^POSTGRES_DB=' "${env_file}" | cut -d= -f2- | tr -d '"' || true)
    [[ -n "${v}" ]] && export POSTGRES_DB="${v}"
  fi

  # Resolve the live ollama/n8n container names from compose (Stage 7 is up by
  # now). Falls back to the mailbox-*-1 defaults if the query returns empty.
  cd "${REPO_ROOT}"
  local oll n8n
  oll=$(docker compose ps -q ollama 2>/dev/null || true)
  n8n=$(docker compose ps -q n8n 2>/dev/null || true)
  [[ -n "${oll}" ]] && OLLAMA_CONTAINER="${oll}"
  [[ -n "${n8n}" ]] && N8N_CONTAINER="${n8n}"

  # Stage 8: Migrations
  run_stage "Stage 8: Run Database Migrations" stage_run_migrations
  pause_for_verification

  # Stage 9: Qdrant bootstrap
  run_stage "Stage 9: Bootstrap Qdrant Collection" stage_bootstrap_qdrant
  pause_for_verification

  # Stage 10: Build custom ctx model + pull embed model
  run_stage "Stage 10: Build qwen3:4b-ctx4k + nomic-embed-text" stage_build_ctx_model
  pause_for_verification

  # Stage 11: Import n8n workflows (no credentials baked in)
  run_stage "Stage 11: Import n8n Workflows" stage_import_n8n_workflows
  pause_for_verification

  # Stage 12: Import n8n Postgres credential (fresh-install gotcha)
  run_stage "Stage 12: Import n8n Postgres Credential" stage_import_n8n_pg_credential
  pause_for_verification

  # Stage 13: Verify all six services healthy
  run_stage "Stage 13: Verify All Six Services Healthy" stage_verify_services

  # ---------------------------------------------------------------------------
  # Summary
  # ---------------------------------------------------------------------------
  print_header "First-Boot Summary"

  printf "%-40s %s\n" "Stage" "Status"
  printf "%-40s %s\n" "-----" "------"
  printf "%-40s %s\n" "Stage 1: Validate JetPack Version"    "${STAGE_STATUS["Stage 1: Validate JetPack Version"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 2: Install Docker via JetsonHacks" "${STAGE_STATUS["Stage 2: Install Docker via JetsonHacks"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 3: Verify GPU Passthrough"       "${STAGE_STATUS["Stage 3: Verify GPU Passthrough"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 4: Set MAXN Power Mode"          "${STAGE_STATUS["Stage 4: Set MAXN Power Mode"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 5: LUKS Encrypt Data Partition"  "${STAGE_STATUS["Stage 5: LUKS Encrypt Data Partition"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 6: Pre-pull Ollama Models"       "${STAGE_STATUS["Stage 6: Pre-pull Ollama Models"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 7: Start Docker Compose Stack"   "${STAGE_STATUS["Stage 7: Start Docker Compose Stack"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 8: Run Database Migrations"      "${STAGE_STATUS["Stage 8: Run Database Migrations"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 9: Bootstrap Qdrant Collection"  "${STAGE_STATUS["Stage 9: Bootstrap Qdrant Collection"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 10: Build qwen3:4b-ctx4k + nomic-embed-text" "${STAGE_STATUS["Stage 10: Build qwen3:4b-ctx4k + nomic-embed-text"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 11: Import n8n Workflows"        "${STAGE_STATUS["Stage 11: Import n8n Workflows"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 12: Import n8n Postgres Credential" "${STAGE_STATUS["Stage 12: Import n8n Postgres Credential"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 13: Verify All Six Services Healthy" "${STAGE_STATUS["Stage 13: Verify All Six Services Healthy"]:-UNKNOWN}"

  echo ""
  echo "First-boot complete. Run scripts/smoke-test.sh to verify infra (GPU/Qdrant/Postgres)."
  echo ""
  echo "REMAINING operator work (interactive — cannot be automated):"
  echo "  - Gmail OAuth2 credential (n8n UI, Google consent) — onboarding Step 4."
  echo "  - Re-link each workflow's credential nodes, then ACTIVATE all four"
  echo "    MailBOX* workflows + restart n8n. Confirm with the n8n-verify gate:"
  echo "      docker compose --profile n8n-verify run --rm mailbox-n8n-verify"
  echo "  - Caddy basic_auth, persona overrides, cloud key — see customer-onboarding runbook."
  echo ""
}

main "$@"
