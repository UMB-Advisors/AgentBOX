#!/usr/bin/env bash
# hermesBOX — Phase 0: base platform bring-up (idempotent)
# Target: Jetson Orin Nano 8GB "super" devkit, JetPack 7.2 (L4T r39.2, Ubuntu 24.04), CUDA 13, NVMe root.
# Runs AS the appliance user (mailbox) on the box. Safe to re-run.
# Spec: docs/PRD-v1.0.0.md §8 Phase 0 · docs/CONTEXT-phase-0-v1.0.0.md · Linear UMB-379
set -euo pipefail

# Pinned versions (Constitution §4 — exact pins, no ranges)
PY_VERSION="3.11"        # uv-managed; 24.04 default is 3.12 but components pin 3.11
NODE_MAJOR="22"          # Node 22 LTS (Jod); nodesource setup_22.x supports noble/24.04
ENV_FILE="${HOME}/.hermesbox_env.sh"
MARKER="# >>> hermesBOX env >>>"
MARKER_END="# <<< hermesBOX env <<<"

log() { printf '\n\033[1;36m[phase0]\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
log "1/6 — uv (Python toolchain manager)"
if ! have uv && [ ! -x "${HOME}/.local/bin/uv" ]; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
else
  echo "uv already present: $("${HOME}/.local/bin/uv" --version 2>/dev/null || uv --version)"
fi
export PATH="${HOME}/.local/bin:${PATH}"

log "2/6 — Python ${PY_VERSION} via uv"
if ! uv python find "${PY_VERSION}" >/dev/null 2>&1; then
  uv python install "${PY_VERSION}"
else
  echo "Python ${PY_VERSION} already managed by uv: $(uv python find ${PY_VERSION})"
fi

# ---------------------------------------------------------------------------
log "3/6 — Bun (gbrain runtime)"
if ! have bun && [ ! -x "${HOME}/.bun/bin/bun" ]; then
  curl -fsSL https://bun.sh/install | bash
else
  echo "bun already present: $("${HOME}/.bun/bin/bun" -v 2>/dev/null || bun -v)"
fi

# ---------------------------------------------------------------------------
log "4/6 — Node ${NODE_MAJOR} LTS (WhatsApp bridge + dashboard build)"
if ! have node || [ "$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')" != "${NODE_MAJOR}" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "node already present: $(node -v)"
fi

# ---------------------------------------------------------------------------
log "5/6 — canonical env file (CUDA + uv + bun on PATH for all shells & systemd)"
cat > "${ENV_FILE}" <<'EOF'
# hermesBOX canonical environment — sourced by interactive shells and systemd units.
# CUDA 13 (JetPack 7.2 / L4T r39.2)
export CUDA_HOME="/usr/local/cuda"
export PATH="${CUDA_HOME}/bin:${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"
export LD_LIBRARY_PATH="${CUDA_HOME}/lib64:${LD_LIBRARY_PATH:-}"
[ -d "${HOME}/.bun" ] && export BUN_INSTALL="${HOME}/.bun"
EOF

# Idempotently source it from .bashrc and .profile (guarded block, never duplicated)
ensure_sourced() {
  local rc="$1"
  [ -f "$rc" ] || touch "$rc"
  if ! grep -qF "${MARKER}" "$rc"; then
    {
      printf '\n%s\n' "${MARKER}"
      printf '[ -f "%s" ] && . "%s"\n' "${ENV_FILE}" "${ENV_FILE}"
      printf '%s\n' "${MARKER_END}"
    } >> "$rc"
    echo "added hermesBOX env source to $rc"
  else
    echo "$rc already sources hermesBOX env"
  fi
}
ensure_sourced "${HOME}/.bashrc"
ensure_sourced "${HOME}/.profile"

# ---------------------------------------------------------------------------
log "6/6 — activate existing 4GB /swapfile as low-priority spillover (zram stays primary)"
if [ -f /swapfile ]; then
  if ! swapon --show=NAME --noheadings | grep -q '/swapfile'; then
    sudo chmod 600 /swapfile
    sudo swapon --priority 1 /swapfile || echo "swapon /swapfile failed (non-fatal)"
  else
    echo "/swapfile already active"
  fi
  # Persist in fstab (idempotent), low priority so zram (prio 5) is used first
  if ! grep -qE '^\s*/swapfile\s' /etc/fstab; then
    echo '/swapfile none swap sw,pri=1 0 0' | sudo tee -a /etc/fstab >/dev/null
    echo "added /swapfile to /etc/fstab (pri=1)"
  else
    echo "/swapfile already in /etc/fstab"
  fi
else
  echo "no /swapfile present — zram-only (acceptable)"
fi

log "Phase 0 provisioning complete. Run verify-phase0.sh to check acceptance criteria."
