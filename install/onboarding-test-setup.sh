#!/usr/bin/env bash
# AgentBOX WiFi-AP onboarding — one-shot setup. Run ON THE BOX as the box user.
#
# Turns a box that has both repos cloned into a working onboarding-AP host:
# installs the AP unit + sudoers + state dir, builds the wizard UI, syncs the
# sidecar's Python deps, and starts the sidecar. Idempotent — safe to re-run.
#
# Assumes:  ~/AgentBOX           (monorepo, branch feat/onboarding-wifi-ap)
#           ~/agentbox-sidecar   (sidecar,  branch feat/onboarding-oobe)
# Override with MONO=... SIDE=... if cloned elsewhere.
set -euo pipefail

MONO="${MONO:-$HOME/AgentBOX}"
SIDE="${SIDE:-$HOME/agentbox-sidecar}"
log(){ printf '\n\033[1;36m[setup]\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31m[setup] %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$MONO/provisioning" ] || die "missing $MONO — clone the monorepo first (git clone -b feat/onboarding-wifi-ap ...)"
[ -d "$SIDE/web" ]          || die "missing $SIDE — clone the sidecar first (git clone -b feat/onboarding-oobe ...)"

# 1. uv — the sidecar's Python runtime
if ! command -v uv >/dev/null && [ ! -x "$HOME/.local/bin/uv" ]; then
  log "installing uv"; curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"

# 2. Node >= 20.19 + pnpm — only needed to BUILD the wizard UI on the box.
#    Vite 7 dropped Node 18, and apt ships 18, so pull Node 22 from NodeSource.
node_major=0
command -v node >/dev/null 2>&1 && node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "${node_major:-0}" -lt 20 ]; then
  log "installing Node.js 22 (Vite 7 needs >=20.19; apt ships 18)"
  sudo apt-get remove -y npm 2>/dev/null || true
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
# Force pnpm 9: pnpm 10/11 hard-error on un-approved dependency build scripts on
# EVERY command (even rebuild), and won't run them non-interactively. pnpm 9 has
# no such gate. Disable any corepack shim first so the pinned version wins.
sudo corepack disable >/dev/null 2>&1 || true
sudo npm install -g pnpm@9
hash -r 2>/dev/null || true

# 3. build the wizard UI + sync sidecar deps
log "building wizard UI (web/dist)"
(
  cd "$SIDE/web"
  # Clean install so build scripts actually run (a cached node_modules makes pnpm
  # skip them). With pnpm 9 there's no approval gate, so esbuild's native binary
  # is built and `vite build` succeeds.
  rm -rf node_modules
  pnpm install
  pnpm build
)
log "syncing sidecar Python deps (uv sync)"
( cd "$SIDE" && uv sync )

# 4. system bits: AP script + unit + writable state dir + nmcli sudoers
log "installing AP unit + state dir + sudoers"
sudo install -m0755 "$MONO/provisioning/35-onboarding-ap.sh"      /usr/local/sbin/agentbox-onboarding-ap
sudo install -m0644 "$MONO/provisioning/35-onboarding-ap.service" /etc/systemd/system/agentbox-onboarding-ap.service
sudo install -d -m0775 -o "$USER" -g "$USER" /var/lib/agentbox
printf '%s ALL=(root) NOPASSWD: %s\n' "$USER" "$(command -v nmcli)" | sudo tee /etc/sudoers.d/agentbox-onboarding-nmcli >/dev/null
sudo chmod 0440 /etc/sudoers.d/agentbox-onboarding-nmcli
sudo visudo -cf /etc/sudoers.d/agentbox-onboarding-nmcli >/dev/null || die "sudoers rule failed validation"
sudo systemctl daemon-reload
sudo systemctl enable agentbox-onboarding-ap.service >/dev/null

# 5. sidecar user service (runs at boot via linger; binds per onboarding.env)
log "installing + starting the sidecar service"
mkdir -p "$HOME/.config/systemd/user"
cp "$SIDE/deploy/agentbox-sidecar.service" "$HOME/.config/systemd/user/"
sudo loginctl enable-linger "$USER" 2>/dev/null || loginctl enable-linger "$USER" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now agentbox-sidecar

sleep 3
log "sidecar health check:"; curl -fsS 127.0.0.1:9200/healthz && echo "  OK" || echo "  NOT answering (check: systemctl --user status agentbox-sidecar)"
log "AP status:"; /usr/local/sbin/agentbox-onboarding-ap status 2>/dev/null || true

cat <<EOF

────────────────────────────────────────────────────────────
Setup done. To run the test, take the box offline so the AP fires:

  $MONO/install/onboarding-test-reset.sh
  sudo reboot

Then on your phone: join AgentBOX-Setup-XXXX, open http://10.42.0.1:9200/onboarding
────────────────────────────────────────────────────────────
EOF
