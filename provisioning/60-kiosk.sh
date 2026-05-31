#!/usr/bin/env bash
# hermesBOX — Phase 6: on-screen kiosk GUI (web dashboard via cog/WPE; chromium fallback).
# Idempotent. Runs AS the appliance user (mailbox) on the box. Safe to re-run.
# Spec: docs/PRD-v1.0.0.md §8 Phase 6 (DR-005/DR-007) · Linear UMB-385
#
# WHAT THIS DOES (automated):
#   1. Install kiosk apt packages (Xorg already present): matchbox-window-manager,
#      cog (WPE WebKit launcher), unclutter, xserver-xorg-video-fbdev.
#   2. PRE-BUILD the hermes web dashboard SPA (vite -> hermes_cli/web_dist) so the
#      dashboard can be started with --skip-build and binds :9119 *fast*.
#      (This is the root cause of the earlier "did not bind :9119 in 20s" failure —
#       see the DIAGNOSIS block below. The dashboard builds the SPA on first launch;
#       on a Jetson that build is minutes, not seconds.)
#   3. Install a hermes-dashboard user service (binds 127.0.0.1:9119, TUI tab on).
#   4. Install the kiosk launcher + Xorg + matchbox + cog systemd unit (GPU compositing
#      capped), plus a chromium fallback unit (installed but DISABLED).
#   5. Print the verify-then-commit procedure (needs a physical display — HUMAN STEP).
#
# WHAT THIS DOES NOT DO (left to the main agent / human):
#   - enable/start any unit (mutation). This script only authors + installs files.
#   - install the chromium snap (only needed if cog/WPE verification fails — see fallback).
#   - decide cog-vs-chromium: that is the human verify-then-commit decision.
#
# ===========================================================================
# DIAGNOSIS — why `hermes dashboard --no-open` did NOT bind :9119 within 20s
# ===========================================================================
# Probed on the box (read-only) 2026-05-30, hermes-agent v0.15.1:
#   * The `web` Python extra IS installed in the venv
#     (~/.hermes/hermes-agent/venv): fastapi 0.133.1, uvicorn[standard] 0.41.0,
#     starlette 1.0.1, websockets 15.0.1, sse_starlette — so it is NOT a
#     missing-Python-dep problem. `python -c "import fastapi"` succeeds in the venv.
#   * The React SPA is served from hermes_cli/web_dist/, which DID NOT EXIST.
#     web/vite.config.ts sets outDir "../hermes_cli/web_dist"; web/node_modules
#     is present but no build output was ever produced.
#   * `hermes dashboard` calls _web_ui_build_needed() (main.py): if web_dist is
#     missing/stale it runs `npm run build` == `tsc -b && vite build` BEFORE it
#     binds the port. On the Orin Nano that TypeScript+Vite bundle of a ~256-pkg
#     React/three.js SPA takes minutes, so a 20s probe times out before the
#     listener ever opens. web_server.py confirms: if `not WEB_DIST.exists()` the
#     SPA route returns {"error":"Frontend not built. Run: cd web && npm run build"}.
#   THE FIX: pre-build the SPA once (this script, step 2), then launch the
#   dashboard with `--skip-build` so it serves the existing dist and binds :9119
#   immediately. `--tui` (or HERMES_DASHBOARD_TUI=1) exposes the in-browser Chat
#   tab (embedded `hermes --tui` over PTY/WebSocket) — required for the ChatPage.
# ===========================================================================
set -euo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true

# Pinned versions (Constitution §4 — exact pins for what we add)
COG_VERSION="0.12.1-1"                       # WPE WebKit launcher (jammy arm64)
MATCHBOX_VERSION="1.2.2+git20200512-1build1" # minimal stacking WM
DASH_PORT="9119"
DASH_HOST="127.0.0.1"
DASH_URL="http://127.0.0.1:9119"

HH="${HERMES_HOME:-$HOME/.hermes}"
P="$HH/hermes-agent"
WEB_DIR="$P/web"
WEB_DIST="$P/hermes_cli/web_dist"
HERMES_BIN="$(command -v hermes || echo "$HOME/.local/bin/hermes")"
USER_SYSTEMD="$HOME/.config/systemd/user"
PROV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '\n\033[1;36m[phase6-kiosk]\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
log "1/5 — kiosk apt packages (Xorg + xinit already present from Phase 0)"
# matchbox-window-manager: tiny WM so cog/chromium gets a fullscreen managed window.
# cog: WPE WebKit single-page kiosk launcher (primary renderer).
# unclutter: hide the X cursor on the kiosk.
# xserver-xorg-video-fbdev: generic modesetting fallback driver for the Tegra display.
PKGS=(matchbox-window-manager cog unclutter xserver-xorg-video-fbdev)
MISSING=()
for p in "${PKGS[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p")
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  log "installing: ${MISSING[*]}"
  sudo apt-get update -qq
  # cog pulls libwpewebkit-1.0-3 + libwpebackend-fdo-1.0-1 as deps (apt resolves).
  sudo apt-get install -y "${MISSING[@]}"
else
  echo "all kiosk packages already installed"
fi
echo "--- versions ---"
dpkg -s cog 2>/dev/null | awk -F': ' '/^Version/{print "cog "$2}'           || true
dpkg -s matchbox-window-manager 2>/dev/null | awk -F': ' '/^Version/{print "matchbox "$2}' || true

# ---------------------------------------------------------------------------
log "2/5 — PRE-BUILD the hermes dashboard SPA (root-cause fix for the :9119 bind timeout)"
if [ ! -f "$WEB_DIST/index.html" ]; then
  if [ ! -d "$WEB_DIR" ]; then
    echo "WARN: $WEB_DIR not found — cannot build dashboard SPA. Skipping (dashboard will build on first launch)."
  else
    log "building React SPA: (cd $WEB_DIR && npm ci && npm run build) -> $WEB_DIST"
    # npm ci is lockfile-strict + non-mutating; matches hermes-agent's own build path.
    ( cd "$WEB_DIR" && {
        if [ ! -d node_modules ]; then npm ci --no-fund --no-audit --progress=false; fi
        npm run build
      } )
  fi
else
  echo "web_dist already built: $WEB_DIST/index.html present (skip)"
fi
[ -f "$WEB_DIST/index.html" ] && echo "SPA dist OK: $WEB_DIST/index.html" || echo "SPA dist MISSING (dashboard will fall back to build-on-launch)"

# ---------------------------------------------------------------------------
log "3/5 — install hermes-dashboard user service (serves $DASH_URL, TUI chat tab on)"
mkdir -p "$USER_SYSTEMD"
cat > "$USER_SYSTEMD/hermes-dashboard.service" <<EOF
[Unit]
Description=hermesBOX — hermes web dashboard (:$DASH_PORT, loopback only)
Documentation=https://github.com/NousResearch/hermes-agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Loopback-only bind => no auth gate, no key exposure (web_server.should_require_auth).
# --skip-build: serve the pre-built dist (step 2) so the listener opens immediately.
# --tui: expose the in-browser Chat tab (embedded 'hermes --tui' over PTY/WebSocket).
Environment=HERMES_HOME=%h/.hermes
Environment=HERMES_DASHBOARD_TUI=1
Environment=HERMES_ACCEPT_HOOKS=1
ExecStart=${HERMES_BIN} dashboard --host ${DASH_HOST} --port ${DASH_PORT} --no-open --skip-build --tui
ExecStop=${HERMES_BIN} dashboard --stop
Restart=on-failure
RestartSec=3
# Wait for the listener before declaring the kiosk's dependency satisfied.

[Install]
WantedBy=default.target
EOF
echo "wrote $USER_SYSTEMD/hermes-dashboard.service"

# ---------------------------------------------------------------------------
log "4/5 — install kiosk launcher scripts + Xorg/matchbox/cog unit + chromium fallback unit"

# 4a. cog/WPE launcher (PRIMARY renderer) ----------------------------------
install -m 0755 "$PROV_DIR/60-kiosk-cog.sh"      "$HOME/.local/bin/hermesbox-kiosk-cog.sh"      2>/dev/null \
  || { mkdir -p "$HOME/.local/bin"; install -m 0755 "$PROV_DIR/60-kiosk-cog.sh" "$HOME/.local/bin/hermesbox-kiosk-cog.sh"; }
# 4b. chromium launcher (FALLBACK renderer) --------------------------------
install -m 0755 "$PROV_DIR/60-kiosk-chromium.sh" "$HOME/.local/bin/hermesbox-kiosk-chromium.sh"
echo "installed launchers -> ~/.local/bin/hermesbox-kiosk-{cog,chromium}.sh"

# 4c. the kiosk systemd units (cog primary enabled-by-WantedBy; chromium present, NOT enabled)
install -m 0644 "$PROV_DIR/60-hermesbox-kiosk-cog.service"      "$USER_SYSTEMD/hermesbox-kiosk-cog.service"
install -m 0644 "$PROV_DIR/60-hermesbox-kiosk-chromium.service" "$USER_SYSTEMD/hermesbox-kiosk-chromium.service"
echo "wrote $USER_SYSTEMD/hermesbox-kiosk-{cog,chromium}.service"

# ---------------------------------------------------------------------------
log "5/5 — DONE (files authored; nothing enabled/started — that is the human verify step)"
cat <<'NEXT'

================  HUMAN-IN-THE-LOOP: verify-then-commit  ================
Requires a PHYSICAL DISPLAY attached to the Orin Nano (interactive blocker).

  A) Enable lingering so user services run at boot without a login session:
       sudo loginctl enable-linger "$USER"
       systemctl --user daemon-reload

  B) Start the dashboard and confirm it binds FAST (the bug fix):
       systemctl --user start hermes-dashboard.service
       # within a couple seconds:
       curl -fsS http://127.0.0.1:9119/ >/dev/null && echo "DASHBOARD UP"
       hermes dashboard --status

  C) Try the PRIMARY renderer (cog / WPE):
       systemctl --user start hermesbox-kiosk-cog.service
     LOOK AT THE SCREEN. The dashboard must be fullscreen, no WM chrome, and
     the embedded Chat tab (xterm/WebSocket) must render + stream a reply.

  D) DECISION:
     - cog/WPE renders correctly  -> COMMIT to cog:
         systemctl --user enable hermes-dashboard.service hermesbox-kiosk-cog.service
     - cog/WPE mis-renders (xterm/WebSocket ChatPage broken, blank, or GL crash)
       -> COMMIT to chromium fallback:
         systemctl --user stop hermesbox-kiosk-cog.service
         # install the chromium snap (jammy arm64 has only the transitional apt stub):
         sudo snap install chromium
         systemctl --user enable hermes-dashboard.service hermesbox-kiosk-chromium.service
         systemctl --user start hermesbox-kiosk-chromium.service
       Record WHY in STATE (which renderer + the mis-render symptom).

  Enable EXACTLY ONE kiosk unit (cog XOR chromium). Both pull in
  hermes-dashboard.service via Requires=, so enable the dashboard too.

  Verify GPU contention guard (Constitution / DR-005): with the kiosk live and
  an agent reply streaming, `tegrastats` GR3D should be ~idle from the GUI —
  the compositor must not fight inference for unified VRAM.
=========================================================================
NEXT
echo "PHASE6_PROVISION_DONE"
