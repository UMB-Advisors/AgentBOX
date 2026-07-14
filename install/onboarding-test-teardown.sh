#!/usr/bin/env bash
# Simulate a FRESH FLASH: wipe everything the onboarding feature + setup script
# put on this box, so the next `onboarding-test-setup.sh` run proves it works
# from scratch. Run ON THE BOX (will prompt for sudo).
#
# Removes: the sidecar clone, built artifacts, the AP unit + script, the sidecar
# service, the nmcli sudoers rule, the state dir, the agentbox-* NetworkManager
# profiles, onboarding state, avahi, and the Node/pnpm/uv toolchain the setup
# script installs. KEEPS: the monorepo clone (a real flash clones it; this script
# lives in it) and your normal home-WiFi connection (only re-enables autoconnect).
#
# After this, the box resembles a freshly-flashed unit with only the monorepo
# present — exactly what onboarding-test-setup.sh expects to build up from.
set -uo pipefail
log(){ printf '\n\033[1;36m[fresh-flash]\033[0m %s\n' "$*"; }

SIDE="${SIDE:-$HOME/agentbox-sidecar}"

log "stopping + removing the sidecar service"
systemctl --user disable --now agentbox-sidecar 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/agentbox-sidecar.service"
systemctl --user daemon-reload 2>/dev/null || true

log "removing the onboarding-AP unit + script"
sudo systemctl disable --now agentbox-onboarding-ap.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/agentbox-onboarding-ap.service /usr/local/sbin/agentbox-onboarding-ap
sudo systemctl daemon-reload

log "removing sudoers rule, state dir, and NetworkManager profiles"
sudo rm -f /etc/sudoers.d/agentbox-onboarding-nmcli
sudo rm -rf /var/lib/agentbox
sudo nmcli connection delete agentbox-onboarding-ap 2>/dev/null || true
sudo nmcli connection delete agentbox-home 2>/dev/null || true
rm -f "$HOME/.hermes/onboarding.json"

log "re-enabling autoconnect on your home WiFi"
nmcli -t -f NAME,TYPE connection show | awk -F: '$2=="802-11-wireless"{print $1}' | while read -r c; do
  [ "$c" = "agentbox-onboarding-ap" ] && continue
  sudo nmcli connection modify "$c" connection.autoconnect yes 2>/dev/null || true
done

log "removing the sidecar clone + built artifacts"
rm -rf "$SIDE"

log "removing the toolchain the setup script installs (avahi, pnpm, uv, Node)"
sudo systemctl disable --now avahi-daemon 2>/dev/null || true
sudo apt-get purge -y avahi-daemon >/dev/null 2>&1 || true
sudo corepack disable >/dev/null 2>&1 || true
sudo npm rm -g pnpm pnpx >/dev/null 2>&1 || true
for d in /usr/local/bin /usr/bin /bin; do sudo rm -f "$d/pnpm" "$d/pnpx" 2>/dev/null || true; done
rm -rf "$HOME/.local/bin/uv" "$HOME/.local/bin/uvx" "$HOME/.local/share/uv" "$HOME/.cache/uv"
sudo apt-get purge -y nodejs >/dev/null 2>&1 || true
sudo rm -f /etc/apt/sources.list.d/nodesource.list 2>/dev/null || true
sudo apt-get autoremove -y >/dev/null 2>&1 || true

cat <<EOF

════════════════════════════════════════════════════════════
 Box wiped to a fresh-flash-like state (only the monorepo remains).
 Now prove the full script works from scratch:

   ~/AgentBOX/install/onboarding-test-setup.sh

 (If the sidecar repo is private and there's no cached git credential,
  run it as:  AB_GH_TOKEN=<github token> ~/AgentBOX/install/onboarding-test-setup.sh)
════════════════════════════════════════════════════════════
EOF
