#!/usr/bin/env bash
# hermesBOX — Phase 6: PRIMARY kiosk launcher (Xorg + matchbox-wm + cog/WPE).
# Brings up a bare X server, a minimal WM, and cog rendering the hermes dashboard
# fullscreen with GPU compositing CAPPED. Launched by hermesbox-kiosk-cog.service.
# Spec: docs/PRD-v1.0.0.md §8 Phase 6 (DR-005) · Linear UMB-385
#
# GPU CONTENTION GUARD (critical on 8GB unified memory — DR-005):
#   WPE/WebKit's compositor shares the unified VRAM pool with the agent's work.
#   We force WPE onto a low/no-GPU path so the browser compositor never fights
#   for memory/SM with on-box GPU work:
#     - WEBKIT_DISABLE_COMPOSITING_MODE=1  -> WebKit uses CPU/3D-less compositing
#     - COG_PLATFORM=x11 / --platform=x11  -> render under Xorg (mature on Tegra),
#       not a direct DRM/Wayland GL path.
set -euo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true

DASH_URL="${HERMESBOX_DASH_URL:-http://127.0.0.1:9200/}"
DISPLAY_NUM="${HERMESBOX_DISPLAY:-:0}"
export DISPLAY="$DISPLAY_NUM"

log() { printf '\n\033[1;36m[kiosk-cog]\033[0m %s\n' "$*"; }

# --- wait for the dashboard to be listening before we paint a blank page ---
log "waiting for dashboard at ${DASH_URL}"
for i in $(seq 1 60); do
  if curl -fsS "${DASH_URL}" >/dev/null 2>&1; then echo "dashboard up"; break; fi
  sleep 1
  [ "$i" -eq 60 ] && { echo "dashboard never came up at ${DASH_URL}"; exit 1; }
done

# --- WPE / WebKit GPU caps (keep the compositor off the inference VRAM pool) ---
export WEBKIT_DISABLE_COMPOSITING_MODE=1   # CPU compositing — no GL compositor
export COG_PLATFORM=x11                     # render under Xorg, not bare DRM/Wayland
export GDK_BACKEND=x11
export MOZ_ENABLE_WAYLAND=0
# WPE needs an explicit backend: Ubuntu 22.04 installs libWPEBackend-fdo but no
# libWPEBackend-default.so symlink, so cog fails with "could not load the impl
# library". Point libwpe at the FDO backend directly.
export WPE_BACKEND_LIBRARY="$(ls /usr/lib/*/libWPEBackend-fdo-1.0.so.1 2>/dev/null | head -1)"

# cog command: fullscreen, single-window kiosk pointed at the dashboard URL.
COG_CMD=(cog --platform=x11 "${DASH_URL}")   # cog 0.12.1 has no -O/--fullscreen; matchbox fullscreens the single window

# --- the X session body: WM + cursor-hide + cog ---------------------------
# Written to a temp xinitrc so xinit owns the whole session lifecycle; when cog
# exits, the X server tears down and systemd restarts the unit.
XINITRC="$(mktemp /tmp/hermesbox-xinitrc.XXXXXX)"
trap 'rm -f "$XINITRC"' EXIT
cat > "$XINITRC" <<EOF
#!/bin/sh
xset -dpms s off s noblank          # never blank/standby the kiosk
xrandr --output DP-1 --mode 1920x1080 2>/dev/null || xrandr -s 1920x1080 2>/dev/null || true
matchbox-window-manager -use_titlebar no &
unclutter -idle 1 -root &
${COG_CMD[*]} &
# Force the cog window to EWMH fullscreen once it maps (cog 0.12.1 has no fullscreen flag).
for _i in \$(seq 1 40); do [ -n "\$(wmctrl -l 2>/dev/null)" ] && break; sleep 0.5; done
for _w in \$(wmctrl -l 2>/dev/null | awk '{print \$1}'); do wmctrl -i -r "\$_w" -b add,fullscreen 2>/dev/null; done
wait
EOF
chmod +x "$XINITRC"

log "starting Xorg + matchbox + cog -> ${DASH_URL} (compositing disabled)"
# vt is owned by the unit (TTYPath). -keeptty/-novtswitch keep us on the console VT.
exec xinit "$XINITRC" -- "$DISPLAY_NUM" vt1 -keeptty -nolisten tcp
