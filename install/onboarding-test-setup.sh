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

# Self-locate the monorepo from THIS script's path (install/onboarding-test-setup.sh
# -> repo root), not a hardcoded ~/AgentBOX — the flash engine clones to ~/agentbox
# (lowercase) on a case-sensitive fs, and this script lives inside whatever that is.
MONO="${MONO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SIDE="${SIDE:-$HOME/agentbox-sidecar}"
# demo/agentbox is the ONLY monorepo branch carrying the full flow (install + AP +
# infra/relay-poc: server, provision-box.sh, self-heal client). Resetting to the old
# feat/onboarding-wifi-ap here WIPED infra/relay-poc/ out of the tree (the reach-me
# code the demo needs). Pin the superset branch.
MONO_BRANCH="${MONO_BRANCH:-demo/agentbox}"
SIDE_BRANCH="${SIDE_BRANCH:-feat/onboarding-oobe}"
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

# 2. pnpm 9 — PINNED to match web/package.json's `packageManager` (pnpm@9.15.9). The box
#    runs pnpm 9; the UI's build-script allowlist lives in web/package.json
#    (pnpm.onlyBuiltDependencies: esbuild, unicode-animations), NOT a pnpm-workspace.yaml —
#    pnpm 9 rejects a settings-only workspace.yaml ("packages field missing or empty"). That
#    file regressed the build 3x; do NOT reintroduce it. Clear stray corepack/npm shims first
#    so a stray pnpm 11 can't win the PATH.
log "installing pnpm 9.15.9 (clearing existing pnpm shims first)"
sudo corepack disable >/dev/null 2>&1 || true
sudo npm rm -g pnpm pnpx >/dev/null 2>&1 || true
for d in /usr/local/bin /usr/bin /bin; do sudo rm -f "$d/pnpm" "$d/pnpx" 2>/dev/null || true; done
sudo npm install -g pnpm@9.15.9
hash -r 2>/dev/null || true
log "pnpm $(pnpm --version 2>/dev/null || echo '?') at $(command -v pnpm 2>/dev/null || echo '?')"

# 3. uv — the sidecar's Python runtime
if ! command -v uv >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/uv" ]; then
  log "installing uv"; curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"

# 4. wizard UI — prefer a PRE-BUILT bundle (no on-box compile) when provisioning a
#    release, else build. CI (agentbox-sidecar .github/workflows/build-web-dist.yml)
#    attaches web-dist.tar.gz to each Release; we fetch it when the sidecar checkout is
#    exactly that release tag. Branch/dev checkouts (and no-asset / offline) build locally.
#    Overrides: AB_UI_PREBUILT=0 forces a build; AB_UI_DIST_URL=<url> fetches a specific tarball.
fetch_prebuilt_dist() {  # 0 = populated $SIDE/web/dist from a prebuilt bundle; 1 = fall back to build
  if [ "${AB_UI_PREBUILT:-auto}" = "0" ]; then return 1; fi
  local tmp tag
  tmp="$(mktemp -d)" || return 1
  if [ -n "${AB_UI_DIST_URL:-}" ]; then
    log "fetching prebuilt UI from AB_UI_DIST_URL"
    local -a auth=()
    if [ -n "${AB_GH_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $AB_GH_TOKEN"); fi
    if ! curl -fsSL "${auth[@]}" -o "$tmp/web-dist.tar.gz" "$AB_UI_DIST_URL"; then rm -rf "$tmp"; return 1; fi
  else
    # Only auto-fetch on an exact release tag — that's what CI attaches the asset to.
    tag="$(git -C "$SIDE" describe --tags --exact-match HEAD 2>/dev/null || true)"
    if [ -z "$tag" ] || ! command -v gh >/dev/null 2>&1; then rm -rf "$tmp"; return 1; fi
    log "fetching prebuilt UI from release $tag"
    if ! GH_TOKEN="${AB_GH_TOKEN:-${GH_TOKEN:-}}" gh release download "$tag" \
         --repo UMB-Advisors/agentbox-sidecar -p 'web-dist.tar.gz' --dir "$tmp" 2>/dev/null; then
      rm -rf "$tmp"; return 1
    fi
  fi
  rm -rf "$SIDE/web/dist"; mkdir -p "$SIDE/web/dist"
  if ! tar -xzf "$tmp/web-dist.tar.gz" -C "$SIDE/web/dist" 2>/dev/null; then rm -rf "$tmp"; return 1; fi
  rm -rf "$tmp"
  if [ ! -f "$SIDE/web/dist/index.html" ]; then return 1; fi
  log "  prebuilt UI installed — skipped the on-box build"
  return 0
}

if fetch_prebuilt_dist; then
  :   # dist came from the prebuilt bundle
else
  log "building wizard UI on-box (clean install; this is the slow step)"
  ( cd "$SIDE/web" && rm -rf node_modules && pnpm install && pnpm build )
  [ -d "$SIDE/web/dist" ] || die "build did not produce $SIDE/web/dist"
fi

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

# When chained by the flash engine (remote, host-driven provisioning) the box
# must stay ONLINE + ssh-reachable so the flash can gate on :9200 and finish.
# Steps 8-9 take WiFi offline and reboot into AP mode — a mid-flash reboot would
# sever the flash's own ssh session and strand the run, and the AP flip is a
# deliberate, separate step for the phone handoff anyway. AB_SKIP_AP_REBOOT=1
# stops here, sidecar installed + running (the flash then hard-gates on :9200).
if [ -n "${AB_SKIP_AP_REBOOT:-}" ]; then
  log "sidecar installed + running; skipping WiFi-offline + AP reboot (AB_SKIP_AP_REBOOT set)."
  log "flip into AP mode when ready for the phone handoff: re-run this script WITHOUT AB_SKIP_AP_REBOOT."
  exit 0
fi

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
