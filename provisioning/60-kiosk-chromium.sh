#!/usr/bin/env bash
# hermesBOX — Phase 6: FALLBACK kiosk launcher (Xorg + matchbox-wm + chromium --kiosk).
# Used ONLY if cog/WPE mis-renders the dashboard (esp. the xterm/WebSocket ChatPage).
# Launched by hermesbox-kiosk-chromium.service. Spec: DR-005 (verified fallback).
#
# GPU CONTENTION GUARD (critical on 8GB unified memory — DR-005):
#   --disable-gpu-compositing (and --disable-gpu) keep Chromium's compositor off
#   the GPU so it never contends with on-box GPU work for unified VRAM.
#
# NOTE ON CHROMIUM ON JAMMY ARM64:
#   The apt `chromium-browser` package is a TRANSITIONAL SNAP STUB (Pre-Depends:
#   snapd) — installing it pulls the `chromium` snap. Provision with:
#       sudo snap install chromium
#   This launcher resolves the binary in PATH order: chromium, chromium-browser,
#   /snap/bin/chromium.
set -euo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true

DASH_URL="${HERMESBOX_DASH_URL:-http://127.0.0.1:9200/}"
DISPLAY_NUM="${HERMESBOX_DISPLAY:-:0}"
export DISPLAY="$DISPLAY_NUM"
PROFILE_DIR="${HOME}/.cache/hermesbox-kiosk-chromium"

log() { printf '\n\033[1;36m[kiosk-chromium]\033[0m %s\n' "$*"; }

# --- resolve a chromium binary --------------------------------------------
CHROME_BIN=""
for c in chromium chromium-browser /snap/bin/chromium; do
  if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME_BIN="$c"; break; fi
done
[ -n "$CHROME_BIN" ] || { echo "no chromium binary found — run: sudo snap install chromium"; exit 1; }

# --- wait for the dashboard listener --------------------------------------
log "waiting for dashboard at ${DASH_URL}"
for i in $(seq 1 60); do
  if curl -fsS "${DASH_URL}" >/dev/null 2>&1; then echo "dashboard up"; break; fi
  sleep 1
  [ "$i" -eq 60 ] && { echo "dashboard never came up at ${DASH_URL}"; exit 1; }
done

mkdir -p "$PROFILE_DIR"

# Chromium kiosk flags — GPU compositing OFF (unified-VRAM guard), no first-run noise.
CHROME_FLAGS=(
  --kiosk
  --disable-gpu-compositing
  --disable-gpu
  --no-first-run
  --no-default-browser-check
  --disable-translate
  --disable-infobars
  --disable-session-crashed-bubble
  --noerrdialogs
  --check-for-update-interval=31536000
  --user-data-dir="${PROFILE_DIR}"
  --app="${DASH_URL}"
)

XINITRC="$(mktemp /tmp/hermesbox-xinitrc.XXXXXX)"
trap 'rm -f "$XINITRC"' EXIT
cat > "$XINITRC" <<EOF
#!/bin/sh
xset -dpms s off s noblank
matchbox-window-manager -use_titlebar no &
unclutter -idle 1 -root &
exec ${CHROME_BIN} ${CHROME_FLAGS[*]}
EOF
chmod +x "$XINITRC"

log "starting Xorg + matchbox + chromium --kiosk -> ${DASH_URL} (GPU compositing disabled)"
exec xinit "$XINITRC" -- "$DISPLAY_NUM" vt1 -keeptty -nolisten tcp
