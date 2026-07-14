#!/usr/bin/env bash
# AgentBOX WiFi-AP onboarding — ONE-SHOT test bring-up. Run ON THE BOX:
#
#     ~/AgentBOX/install/onboarding-test-setup.sh
#
# It does EVERYTHING, no other commands needed:
#   - self-updates both repos to the latest pushed code (no manual git pull)
#   - installs Node 22, pnpm 9, uv as needed
#   - builds the wizard UI + syncs sidecar deps
#   - installs the AP unit + sudoers + state dir, starts the sidecar
#   - clears state, takes WiFi offline, and reboots into AP mode
#
# After it reboots (~90s): join "AgentBOX-Setup-XXXX" on your phone and open
# http://10.42.0.1:9200/onboarding. Requires internet while running (apt/npm/uv).
# Assumes the two repos are cloned at ~/AgentBOX and ~/agentbox-sidecar.
set -euo pipefail

MONO="${MONO:-$HOME/AgentBOX}"
SIDE="${SIDE:-$HOME/agentbox-sidecar}"
MONO_BRANCH="feat/onboarding-wifi-ap"
SIDE_BRANCH="feat/onboarding-oobe"
log(){ printf '\n\033[1;36m[onboarding]\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31m[onboarding] ERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$MONO/.git" ] || die "missing $MONO — this script must live in a clone of the monorepo"

# Clone (if missing) or hard-reset a repo to the exact latest of its branch. The
# monorepo is assumed present (a fresh flash clones it + runs agentbox-install.sh);
# the sidecar is cloned here if absent. Private repos need a credential: a cached
# git/gh credential, or AB_GH_TOKEN=<github token> in the environment.
ensure_repo() { # $1=dir $2=reponame $3=branch
  local dir="$1" repo="$2" branch="$3"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch -q origin "$branch" && git -C "$dir" reset -q --hard "origin/$branch" \
      || log "WARN: could not update $dir; using local copy"
  else
    log "cloning $repo ($branch)"
    local url="https://github.com/UMB-Advisors/${repo}.git"
    [ -n "${AB_GH_TOKEN:-}" ] && url="https://${AB_GH_TOKEN}@github.com/UMB-Advisors/${repo}.git"
    git clone -q -b "$branch" "$url" "$dir" \
      || die "clone of $repo failed — if it's private, re-run with AB_GH_TOKEN=<github token> $0"
  fi
}

# 0. Ensure both repos present + at latest, then re-exec the fresh script once.
if [ -z "${AB_REEXEC:-}" ]; then
  log "ensuring repos are present + up to date"
  ensure_repo "$MONO" AgentBOX "$MONO_BRANCH"
  ensure_repo "$SIDE" agentbox-sidecar "$SIDE_BRANCH"
  export AB_REEXEC=1
  exec bash "$MONO/install/onboarding-test-setup.sh" "$@"
fi
[ -d "$SIDE/web" ] || die "sidecar checkout looks wrong (no web/) at $SIDE"

# 1. Node >= 20 (Vite 7 dropped 18; apt ships 18, so pull Node 22 from NodeSource).
node_major=0
command -v node >/dev/null 2>&1 && node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "${node_major:-0}" -lt 20 ]; then
  log "installing Node.js 22"
  sudo apt-get remove -y npm >/dev/null 2>&1 || true
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# 2. pnpm — prefer 9 (no build-script gate). Forcefully clear every existing
#    pnpm/corepack shim first (npm won't overwrite a corepack symlink, which is
#    why a plain `npm i -g pnpm@9` left v11 in place). If 9 still can't win, the
#    web/pnpm-workspace.yaml allowlist lets a *clean* install build esbuild on
#    pnpm 11 too — so we proceed regardless of the resolved version.
log "installing pnpm 9 (clearing existing pnpm shims first)"
sudo corepack disable >/dev/null 2>&1 || true
sudo npm rm -g pnpm pnpx >/dev/null 2>&1 || true
for d in /usr/local/bin /usr/bin /bin; do sudo rm -f "$d/pnpm" "$d/pnpx" 2>/dev/null || true; done
sudo npm install -g pnpm@9
hash -r 2>/dev/null || true
log "pnpm $(pnpm --version 2>/dev/null || echo '?') at $(command -v pnpm 2>/dev/null || echo '?')"

# 3. uv — the sidecar's Python runtime
if ! command -v uv >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/uv" ]; then
  log "installing uv"; curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"

# 4. build the wizard UI (clean install so build scripts actually run)
log "building wizard UI (this is the slow step)"
( cd "$SIDE/web" && rm -rf node_modules && pnpm install && pnpm build )
[ -d "$SIDE/web/dist" ] || die "build did not produce $SIDE/web/dist"

# 5. sidecar Python deps
log "syncing sidecar deps (uv sync)"
( cd "$SIDE" && uv sync )

# 6. system bits: AP unit + writable state dir + nmcli sudoers
log "installing AP unit + sudoers + state dir"
sudo install -m0755 "$MONO/provisioning/35-onboarding-ap.sh"      /usr/local/sbin/agentbox-onboarding-ap
sudo install -m0644 "$MONO/provisioning/35-onboarding-ap.service" /etc/systemd/system/agentbox-onboarding-ap.service
sudo install -d -m0775 -o "$USER" -g "$USER" /var/lib/agentbox
printf '%s ALL=(root) NOPASSWD: %s\n' "$USER" "$(command -v nmcli)" | sudo tee /etc/sudoers.d/agentbox-onboarding-nmcli >/dev/null
sudo chmod 0440 /etc/sudoers.d/agentbox-onboarding-nmcli
sudo visudo -cf /etc/sudoers.d/agentbox-onboarding-nmcli >/dev/null || die "sudoers rule failed validation"
sudo systemctl daemon-reload
sudo systemctl enable agentbox-onboarding-ap.service >/dev/null

# 6.5 at-rest mail-secret key — the box stores the pending mailbox creds
#     encrypted (fully-operational-from-phone OOBE), so this must exist. Generate
#     once into ~/.hermes/.env (sourced by the sidecar unit). 32 bytes = 64 hex.
ENVF="$HOME/.hermes/.env"
mkdir -p "$HOME/.hermes"; touch "$ENVF"; chmod 600 "$ENVF"
if grep -q '^HERMES_MAIL_SECRET_KEY=' "$ENVF" 2>/dev/null; then
  log "HERMES_MAIL_SECRET_KEY already set"
else
  printf 'HERMES_MAIL_SECRET_KEY=%s\n' "$(openssl rand -hex 32)" >> "$ENVF"
  log "generated HERMES_MAIL_SECRET_KEY in $ENVF"
fi

# 7. sidecar user service (runs at boot via linger)
log "installing + starting the sidecar"
mkdir -p "$HOME/.config/systemd/user"
cp "$SIDE/deploy/agentbox-sidecar.service" "$HOME/.config/systemd/user/"
sudo loginctl enable-linger "$USER" >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable --now agentbox-sidecar
sleep 3
curl -fsS 127.0.0.1:9200/healthz >/dev/null 2>&1 && log "sidecar health: OK" || log "WARN: sidecar not answering yet (systemctl --user status agentbox-sidecar)"

# 8. clear state + take WiFi offline so the AP fires on the next boot
log "clearing onboarding state + disabling WiFi autoconnect"
rm -f "$HOME/.hermes/onboarding.json"
sudo rm -f /var/lib/agentbox/onboarding-complete /var/lib/agentbox/onboarding.env /var/lib/agentbox/wifi-scan.cache
sudo nmcli connection delete agentbox-home >/dev/null 2>&1 || true
nmcli -t -f NAME,TYPE connection show | awk -F: '$2=="802-11-wireless"{print $1}' | while read -r c; do
  [ "$c" = "agentbox-onboarding-ap" ] && continue
  sudo nmcli connection modify "$c" connection.autoconnect no >/dev/null 2>&1 || true
done

# 9. reboot into AP mode
cat <<'EOF'

════════════════════════════════════════════════════════════
 SETUP COMPLETE — rebooting in 15s to bring up the setup AP.
 When the box is back (~90s):
   1. Phone WiFi  ->  join  AgentBOX-Setup-XXXX   (open, no password)
   2. Browser     ->  http://10.42.0.1:9200/onboarding
   3. Pick your WiFi  ->  Finish & go online
 Press Ctrl-C in the next 15s to cancel the reboot.
════════════════════════════════════════════════════════════
EOF
sleep 15
sudo reboot
