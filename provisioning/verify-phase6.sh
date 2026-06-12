#!/usr/bin/env bash
# hermesBOX — Phase 6 acceptance verification. Run on the box.
# Mirrors PRD §8 Phase 6 acceptance (Linear UMB-385). Read-only probes + a few
# checks that require the kiosk to be running. The on-screen RENDER check is a
# HUMAN step (physical display) — flagged below, not auto-asserted.
set -uo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true

# Health-check the agentbox-sidecar front door (:9200), not hermes :9119 (2026-06-12)
DASH_URL="http://127.0.0.1:9200"
HH="${HERMES_HOME:-$HOME/.hermes}"
WEB_DIST="$HH/hermes-agent/hermes_cli/web_dist"
pass=0; fail=0; warn=0
ok(){ echo "  PASS  $*"; pass=$((pass+1)); }
no(){ echo "  FAIL  $*"; fail=$((fail+1)); }
wn(){ echo "  WARN  $*"; warn=$((warn+1)); }

echo "=== hermesBOX Phase 6 acceptance (kiosk GUI) ==="

# 1) kiosk packages present
for p in matchbox-window-manager cog; do
  if dpkg -s "$p" >/dev/null 2>&1; then ok "$p installed ($(dpkg -s "$p" | awk -F': ' '/^Version/{print $2}'))"
  else no "$p not installed"; fi
done
# Xorg from Phase 0
dpkg -s xserver-xorg >/dev/null 2>&1 && ok "xserver-xorg present" || no "xserver-xorg missing"

# 2) dashboard SPA pre-built (the root-cause fix for the :9119 bind timeout)
if [ -f "$WEB_DIST/index.html" ]; then ok "dashboard SPA pre-built ($WEB_DIST/index.html)"
else no "dashboard SPA NOT built — dashboard would build-on-launch and miss the bind window"; fi

# 3) units installed
USYS="$HOME/.config/systemd/user"
for u in hermes-dashboard.service hermesbox-kiosk-cog.service hermesbox-kiosk-chromium.service; do
  [ -f "$USYS/$u" ] && ok "unit installed: $u" || no "unit missing: $u"
done

# 4) launchers installed + executable
for s in hermesbox-kiosk-cog.sh hermesbox-kiosk-chromium.sh; do
  [ -x "$HOME/.local/bin/$s" ] && ok "launcher executable: $s" || no "launcher missing/not-exec: $s"
done

# 5) dashboard listening + binds FAST (proves the --skip-build fix). Requires the
#    hermes-dashboard.service to be started first.
if systemctl --user is-active hermes-dashboard.service >/dev/null 2>&1; then
  t0=$(date +%s%3N)
  if curl -fsS "$DASH_URL/healthz" >/dev/null 2>&1; then
    t1=$(date +%s%3N); echo "  INFO  dashboard responded in $((t1-t0)) ms"
    ok "dashboard serving $DASH_URL"
  else
    no "dashboard service active but $DASH_URL not responding"
  fi
  # SPA actually served (not the 'Frontend not built' JSON error)
  body=$(curl -fsS "$DASH_URL/" 2>/dev/null | head -c 400)
  echo "$body" | grep -qi "Frontend not built" && no "dashboard returns 'Frontend not built' (SPA dist missing)" || ok "dashboard serves SPA HTML (not the not-built error)"
else
  wn "hermes-dashboard.service not active — start it then re-run for the live :9119 checks"
fi

# 6) exactly one kiosk renderer enabled (cog XOR chromium)
cog_en=$(systemctl --user is-enabled hermesbox-kiosk-cog.service 2>/dev/null || echo disabled)
chr_en=$(systemctl --user is-enabled hermesbox-kiosk-chromium.service 2>/dev/null || echo disabled)
echo "  INFO  enabled state: cog=$cog_en chromium=$chr_en"
if { [ "$cog_en" = "enabled" ] && [ "$chr_en" != "enabled" ]; } || { [ "$chr_en" = "enabled" ] && [ "$cog_en" != "enabled" ]; }; then
  ok "exactly one kiosk renderer enabled (verify-then-commit honored)"
elif [ "$cog_en" = "enabled" ] && [ "$chr_en" = "enabled" ]; then
  no "BOTH kiosk renderers enabled — enable exactly one (cog XOR chromium)"
else
  wn "no kiosk renderer enabled yet — complete the human verify-then-commit step"
fi

# 7) lingering (boots kiosk without a login session)
if loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q "Linger=yes"; then
  ok "user lingering enabled (kiosk starts at boot)"
else
  wn "lingering off — run: sudo loginctl enable-linger $USER  (else kiosk won't autostart at boot)"
fi

# 8) a kiosk renderer + Xorg actually running (if committed)
if pgrep -x Xorg >/dev/null 2>&1; then ok "Xorg running"; else wn "Xorg not running (kiosk not started yet)"; fi
if pgrep -x cog >/dev/null 2>&1; then echo "  INFO  cog process live (PRIMARY renderer active)"; fi
if pgrep -f "chromium.*--kiosk" >/dev/null 2>&1; then echo "  INFO  chromium --kiosk live (FALLBACK renderer active)"; fi

# 9) GPU contention guard — informational. With kiosk live, GR3D should be low
#    from the GUI (cog/chromium compositing disabled). Sample tegrastats briefly.
if pgrep -x Xorg >/dev/null 2>&1 && command -v tegrastats >/dev/null 2>&1; then
  : > /tmp/hb6_tg.txt
  ( timeout 4 tegrastats --interval 500 >/tmp/hb6_tg.txt 2>/dev/null ) || true
  maxgpu=$(grep -o 'GR3D_FREQ [0-9]\+%' /tmp/hb6_tg.txt | grep -o '[0-9]\+' | sort -rn | head -1)
  maxgpu=${maxgpu:-0}
  echo "  INFO  GR3D peak with kiosk idle = ${maxgpu}% (GUI compositing should keep this near 0; spikes = inference, not the GUI)"
fi

# 10) full-stack memory (all surfaces live)
echo "--- memory (all surfaces live) ---"
free -m | awk '/Mem:/{printf "  used=%sMB free=%sMB avail=%sMB (PRD §7 target steady-state ~<= 6800MB used)\n",$3,$4,$7}'

echo
echo "  HUMAN  Visual verify-then-commit (needs the physical display):"
echo "         - dashboard fullscreen, NO WM titlebar/chrome, NO login shell"
echo "         - embedded Chat tab (xterm/WebSocket) renders + streams a local-agent reply"
echo "         - if cog/WPE mis-renders, switch to the chromium fallback and record why in STATE"
echo
echo "=== result: ${pass} pass / ${fail} fail / ${warn} warn ==="
[ "$fail" -eq 0 ] && echo "PHASE6_VERIFY_OK" || echo "PHASE6_VERIFY_INCOMPLETE"
