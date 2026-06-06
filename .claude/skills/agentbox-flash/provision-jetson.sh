#!/usr/bin/env bash
# provision-jetson.sh — blank Jetson (attached over USB in recovery mode) -> green AgentBOX.
#
# The automatable spine for the /agentbox-flash skill. Staged + resumable + idempotent.
# It does NOT: put the board in recovery mode, do Gmail OAuth, or unlock 1Password.
# Those are human gates the skill surfaces.
#
# Source of truth is GitHub: stage 'deploy' clones AGENTBOX_GIT_URL onto the box and
# runs install/agentbox-install.sh there. (DEPLOY_SOURCE=local rsyncs a local checkout
# instead, for offline/dev use.)
#
# Usage:
#   ./provision-jetson.sh --stage all            # run every stage in order
#   ./provision-jetson.sh --stage flash          # one stage
#   ./provision-jetson.sh --resume hostprep      # this stage and everything after
#   ./provision-jetson.sh --dry-run --stage all  # print what would run, touch nothing
#
# Config: provision.env beside this script (copy from provision.env.example).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$HERE/provision.env}"
DRY=0; STAGE="all"; RESUME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --stage) STAGE="${2:?}"; shift ;;
    --resume) RESUME="${2:?}"; STAGE="all"; shift ;;
    --env) ENV_FILE="${2:?}"; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac; shift
done

log(){ echo "[$(date -u +%H:%M:%S)] $*"; }
die(){ echo "FATAL: $*" >&2; exit 1; }
run(){ if [ "$DRY" = 1 ]; then echo "DRY: $*"; else eval "$*"; fi; }

[ -f "$ENV_FILE" ] || die "missing $ENV_FILE (copy provision.env.example and fill it in)"
# shellcheck disable=SC1090
. "$ENV_FILE"

# ---- defaults / required ---------------------------------------------------
: "${BSP_DIR:?set BSP_DIR to an extracted Linux_for_Tegra/}"
: "${BOARD_CONFIG:=jetson-orin-nano-devkit-super}"
: "${TARGET_DEVICE:=nvme0n1p1}"          # or "internal" for eMMC/SD
: "${BOX_USER:=agentbox}"
: "${BOX_PASS:?set BOX_PASS (baked into rootfs for headless first boot)}"
: "${BOX_HOST:=agentbox}"
: "${BOX_IP:=192.168.55.1}"              # Jetson USB device-mode address
: "${INSTALL_MODE:=--prototype}"         # or "" for production
: "${GITHUB_PACKAGES_TOKEN:?set GITHUB_PACKAGES_TOKEN (installer requires it)}"
# --- deploy source (GitHub by default) -------------------------------------
: "${DEPLOY_SOURCE:=git}"                            # git | local
: "${AGENTBOX_GIT_URL:=https://github.com/UMB-Advisors/AgentBOX.git}"
: "${AGENTBOX_GIT_REF:=main}"                        # until the installer PR merges, use feat/agentbox-installer
: "${GIT_TOKEN:=}"                                   # for a private repo (PAT); never logged
: "${AGENTBOX_REPO:=}"                               # only used when DEPLOY_SOURCE=local
: "${BOX_CHECKOUT:=~/agentbox}"                      # where the repo lands on the box
# The installer clones the MailBOX stack itself; pin it here if needed.
: "${MAILBOX_GIT_URL:=https://github.com/UMB-Advisors/mailbox.git}"
: "${MAILBOX_GIT_REF:=main}"

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8"
BSSH(){ sshpass -p "$BOX_PASS" ssh $SSH_OPTS "$BOX_USER@$BOX_IP" "$@"; }
BRSYNC(){ sshpass -p "$BOX_PASS" rsync -az -e "ssh $SSH_OPTS" "$@"; }

# stage gating for --resume
ORDER="preflight mkuser flash reach hostprep deploy report"
should_run(){
  local s="$1"
  [ "$STAGE" = "all" ] || { [ "$STAGE" = "$s" ] && return 0 || return 1; }
  [ -z "$RESUME" ] && return 0
  local seen=0
  for x in $ORDER; do [ "$x" = "$RESUME" ] && seen=1; [ "$x" = "$s" ] && { [ "$seen" = 1 ] && return 0 || return 1; }; done
  return 1
}

# ── STAGE preflight ─────────────────────────────────────────────────────────
st_preflight(){
  log "STAGE preflight — host deps + board in recovery mode"
  for t in lsusb sshpass rsync python3; do command -v "$t" >/dev/null || die "missing host tool: $t (apt install $t)"; done
  [ -x "$BSP_DIR/flash.sh" ] || die "no flash.sh under BSP_DIR=$BSP_DIR — extract Jetson Linux BSP + sample rootfs and run apply_binaries.sh"
  [ -x "$BSP_DIR/tools/kernel_flash/l4t_initrd_flash.sh" ] || log "WARN: l4t_initrd_flash.sh not found — NVMe flash needs it; internal-device flash will use flash.sh"
  if lsusb | grep -qi '0955:'; then
    log "  APX device present: $(lsusb | grep -i '0955:' | head -1)"
  else
    die "no Jetson in recovery mode (no 0955: on lsusb). HUMAN GATE: power off, hold FORCE RECOVERY, tap power (or fit FC-REC jumper), reconnect USB, re-run."
  fi
}

# ── STAGE mkuser ────────────────────────────────────────────────────────────
st_mkuser(){
  log "STAGE mkuser — bake default user ($BOX_USER@$BOX_HOST) so first boot is headless"
  local tool="$BSP_DIR/tools/l4t_create_default_user.sh"
  [ -x "$tool" ] || { log "  WARN: $tool absent — skipping; first boot may require interactive oem-config"; return 0; }
  run "sudo $tool -u '$BOX_USER' -p '$BOX_PASS' -n '$BOX_HOST' --accept-license --autologin"
}

# ── STAGE flash ─────────────────────────────────────────────────────────────
st_flash(){
  log "STAGE flash — writing Jetson Linux ($BOARD_CONFIG -> $TARGET_DEVICE). ~8-15 min."
  cd "$BSP_DIR"
  if [ "$TARGET_DEVICE" = "internal" ]; then
    run "sudo ./flash.sh $BOARD_CONFIG internal"
  else
    run "sudo ./tools/kernel_flash/l4t_initrd_flash.sh \
      --external-device $TARGET_DEVICE \
      -c tools/kernel_flash/flash_l4t_t234_nvme.xml \
      --showlogs --network usb0 \
      $BOARD_CONFIG internal"
  fi
  log "  flash returned; board will reboot off $TARGET_DEVICE"
}

# ── STAGE reach ─────────────────────────────────────────────────────────────
st_reach(){
  log "STAGE reach — waiting for first boot + SSH on $BOX_IP (up to 5 min)"
  if [ "$DRY" = 1 ]; then echo "DRY: poll ssh $BOX_USER@$BOX_IP"; return 0; fi
  for i in $(seq 1 30); do
    if BSSH true 2>/dev/null; then log "  reachable: $BOX_USER@$BOX_IP"; return 0; fi
    if sshpass -p "$BOX_PASS" ssh $SSH_OPTS "$BOX_USER@$BOX_HOST.local" true 2>/dev/null; then
      BOX_IP="$BOX_HOST.local"; log "  reachable via LAN: $BOX_USER@$BOX_IP"; return 0
    fi
    sleep 10
  done
  die "box never came up on $BOX_IP or $BOX_HOST.local. HUMAN: attach a monitor to triage first boot."
}

# ── STAGE hostprep ──────────────────────────────────────────────────────────
st_hostprep(){
  log "STAGE hostprep — make the box installer-ready (docker nvidia default-runtime, disk, git, internet)"
  if [ "$DRY" = 1 ]; then echo "DRY: ssh host-prep on $BOX_IP"; return 0; fi
  BSSH "set -e
    sudo apt-get update -qq
    command -v git >/dev/null || sudo apt-get install -y -qq git
    command -v docker >/dev/null || { echo 'FATAL: docker missing on box (JetPack should ship it)'; exit 1; }
    # box must reach the internet (apt, GHCR image, ollama model pulls)
    curl -fsS -m 10 https://github.com >/dev/null || { echo 'FATAL: box has no internet (needs LAN/wifi or host NAT over usb0) — installer pulls models + GHCR'; exit 1; }
    # nvidia as DEFAULT runtime (installer STAGE 0 requires it)
    if ! docker info 2>/dev/null | grep -qi 'Default Runtime: nvidia'; then
      echo '{ \"default-runtime\": \"nvidia\", \"runtimes\": { \"nvidia\": { \"path\": \"nvidia-container-runtime\", \"runtimeArgs\": [] } } }' | sudo tee /etc/docker/daemon.json >/dev/null
      sudo systemctl restart docker
    fi
    sudo usermod -aG docker $BOX_USER || true
    avail=\$(df --output=avail -BG \$HOME | tail -1 | tr -dc 0-9)
    [ \"\$avail\" -ge 16 ] || { echo \"FATAL: only \${avail}G free, need >=16G (flash to NVMe?)\"; exit 1; }
    echo 'host prep ok'
  "
  log "  docker default-runtime=nvidia, internet ok, >=16G free, git present"
}

# ── STAGE deploy ────────────────────────────────────────────────────────────
st_deploy(){
  log "STAGE deploy — get agentbox onto box (source=$DEPLOY_SOURCE) + run install/agentbox-install.sh $INSTALL_MODE"
  if [ "$DEPLOY_SOURCE" = "local" ]; then
    [ -n "$AGENTBOX_REPO" ] && [ -x "$AGENTBOX_REPO/install/agentbox-install.sh" ] || die "DEPLOY_SOURCE=local but AGENTBOX_REPO has no install/agentbox-install.sh"
    if [ "$DRY" = 1 ]; then echo "DRY: rsync $AGENTBOX_REPO -> box:$BOX_CHECKOUT + run installer $INSTALL_MODE"; else
      BRSYNC --exclude '.git' "$AGENTBOX_REPO/" "$BOX_USER@$BOX_IP:$BOX_CHECKOUT/"
    fi
  else
    # GitHub source of truth — clone (or fast-forward) on the box itself.
    local url="$AGENTBOX_GIT_URL"
    [ -n "$GIT_TOKEN" ] && url="https://${GIT_TOKEN}@${AGENTBOX_GIT_URL#https://}"   # token never echoed below
    if [ "$DRY" = 1 ]; then
      echo "DRY: box clone ${AGENTBOX_GIT_URL}#${AGENTBOX_GIT_REF} -> $BOX_CHECKOUT + run installer $INSTALL_MODE"
    else
      BSSH "set -e
        if [ -d $BOX_CHECKOUT/.git ]; then
          git -C $BOX_CHECKOUT remote set-url origin '$url'
          git -C $BOX_CHECKOUT fetch --depth 1 origin '$AGENTBOX_GIT_REF'
          git -C $BOX_CHECKOUT checkout -f '$AGENTBOX_GIT_REF'
          git -C $BOX_CHECKOUT reset --hard FETCH_HEAD
        else
          git clone --depth 1 --branch '$AGENTBOX_GIT_REF' '$url' $BOX_CHECKOUT
        fi
        git -C $BOX_CHECKOUT remote set-url origin '$AGENTBOX_GIT_URL'   # strip token from stored remote
      "
    fi
  fi
  if [ "$DRY" = 1 ]; then return 0; fi
  # seed the token so the installer's STAGE 1 gate passes; installer writes the rest
  BSSH "cd $BOX_CHECKOUT && touch .env && grep -q '^GITHUB_PACKAGES_TOKEN=' .env || echo 'GITHUB_PACKAGES_TOKEN=$GITHUB_PACKAGES_TOKEN' >> .env"
  log "  running installer on box (streaming)..."
  BSSH "cd $BOX_CHECKOUT && sg docker -c 'MAILBOX_GIT_URL=$MAILBOX_GIT_URL MAILBOX_GIT_REF=$MAILBOX_GIT_REF ./install/agentbox-install.sh $INSTALL_MODE'"
}

# ── STAGE report ────────────────────────────────────────────────────────────
st_report(){
  log "STAGE report — box state + remaining human gates"
  if [ "$DRY" = 1 ]; then echo "DRY: docker compose ps on box"; return 0; fi
  BSSH "cd $BOX_CHECKOUT && docker compose ps --format '{{.Name}}\t{{.Status}}' || true"
  cat <<'EOF'

REMAINING MANUAL STEPS (installer + skill document these):
  - Gmail OAuth consent (browser, per inbox)            <- human gate
  - GCP: enable Gmail API + add OAuth redirect URI
  - Tailscale Funnel -> basic_auth Caddy -> n8n (config/Caddyfile.funnel.template)
  - Hermes client-mode: `hermes doctor` + `ollama ps` show ONLY nomic + qwen3
  - systemd agentbox.target for boot-to-ready (production)

Smoke: inject inbound -> draft appears; `hermes -z` replies.
EOF
}

# ---- run -------------------------------------------------------------------
for s in $ORDER; do should_run "$s" && "st_$s"; done
log "provision-jetson: done (stage=$STAGE${RESUME:+, resume=$RESUME}, dry=$DRY)"
