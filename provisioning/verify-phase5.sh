#!/usr/bin/env bash
# hermesBOX — Phase 5 acceptance verification (WhatsApp gateway). Run on the box.
# Read-only. Splits checks into QR-READY prerequisites (must pass after 50-whatsapp.sh)
# and PAIRED/LIVE checks (only meaningful after the human scans the QR).
# Mirrors ROADMAP Phase 5 acceptance (Linear UMB-384).
set -uo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true

HH="${HERMES_HOME:-$HOME/.hermes}"
BRIDGE_DIR="${HH}/hermes-agent/scripts/whatsapp-bridge"
SESSION_DIR="${HH}/platforms/whatsapp/session"
ENV_FILE="${HH}/.env"
CFG_FILE="${HH}/config.yaml"
BRIDGE_PORT="${WHATSAPP_BRIDGE_PORT:-3000}"

pass=0; fail=0; warn=0
ok(){ echo "  PASS  $*"; pass=$((pass+1)); }
no(){ echo "  FAIL  $*"; fail=$((fail+1)); }
wn(){ echo "  WARN  $*"; warn=$((warn+1)); }

echo "=== hermesBOX Phase 5 acceptance (WhatsApp) ==="

# ---- QR-READY prerequisites (gate for handing off to QR pairing) -----------
echo "--- QR-ready prerequisites ---"

# 1) Bridge script present
if [ -f "${BRIDGE_DIR}/bridge.js" ]; then ok "bridge.js present (${BRIDGE_DIR})"; else no "bridge.js missing at ${BRIDGE_DIR}"; fi

# 2) node available + version (>=18; box runs 22)
if command -v node >/dev/null 2>&1; then
  nv=$(node -v 2>/dev/null); maj=$(echo "$nv" | sed 's/v\([0-9]*\).*/\1/')
  if [ "${maj:-0}" -ge 18 ] 2>/dev/null; then ok "node ${nv} (>=18)"; else no "node ${nv} too old (need >=18)"; fi
else
  no "node not on PATH"
fi

# 3) Baileys bridge deps installed (NOT chromium — pure WebSocket)
if [ -d "${BRIDGE_DIR}/node_modules" ] && \
   node -e "require('${BRIDGE_DIR}/node_modules/@whiskeysockets/baileys')" >/dev/null 2>&1; then
  ok "bridge deps installed (@whiskeysockets/baileys importable)"
else
  no "bridge node_modules missing or baileys not importable (run 50-whatsapp.sh)"
fi
# Confirm the no-chromium drift: there must be NO puppeteer/chromium dep tree.
if [ -d "${BRIDGE_DIR}/node_modules/puppeteer" ] || [ -d "${BRIDGE_DIR}/node_modules/puppeteer-core" ]; then
  wn "puppeteer present in bridge node_modules — unexpected for a Baileys bridge"
else
  ok "no puppeteer/chromium in bridge deps (Baileys = pure WebSocket, matches drift note)"
fi

# 4) Session dir exists, mode 700
if [ -d "${SESSION_DIR}" ]; then
  perm=$(stat -c '%a' "${SESSION_DIR}" 2>/dev/null)
  if [ "${perm}" = "700" ]; then ok "session dir present, mode 700"; else wn "session dir present but mode=${perm} (want 700)"; fi
else
  no "session dir missing (${SESSION_DIR})"
fi

# 5) .env has WHATSAPP_ENABLED=true + a mode + an allowlist decision
if grep -qiE '^WHATSAPP_ENABLED=(true|1|yes)$' "${ENV_FILE}" 2>/dev/null; then ok "WHATSAPP_ENABLED=true in .env"; else no "WHATSAPP_ENABLED not true in .env"; fi
if grep -qE '^WHATSAPP_MODE=(self-chat|bot)$' "${ENV_FILE}" 2>/dev/null; then
  ok "WHATSAPP_MODE=$(grep -E '^WHATSAPP_MODE=' "${ENV_FILE}" | cut -d= -f2)"
else
  wn "WHATSAPP_MODE not set to self-chat|bot (bridge default self-chat will apply)"
fi
if grep -qE '^WHATSAPP_ALLOWED_USERS=.+' "${ENV_FILE}" 2>/dev/null; then
  ok "WHATSAPP_ALLOWED_USERS set ($(grep -E '^WHATSAPP_ALLOWED_USERS=' "${ENV_FILE}" | cut -d= -f2))"
else
  wn "WHATSAPP_ALLOWED_USERS not set — incoming messages DENIED until configured (deny-all secure default)"
fi

# 6) .env perms 600 (contains creds + soon session-adjacent secrets)
eperm=$(stat -c '%a' "${ENV_FILE}" 2>/dev/null)
if [ "${eperm}" = "600" ]; then ok ".env mode 600"; else wn ".env mode=${eperm} (want 600)"; fi

# ---- PAIRED / LIVE checks (only after the human scans the QR) ---------------
echo "--- paired / live checks (post-QR) ---"

if [ -f "${SESSION_DIR}/creds.json" ]; then
  ok "creds.json present — device is PAIRED"

  # Bridge health (only meaningful once the gateway has launched the bridge).
  # Loopback-only; bridge validates Host header so we must send Host: localhost.
  hp=$(curl -fsS -H 'Host: localhost' "http://127.0.0.1:${BRIDGE_PORT}/health" 2>/dev/null)
  if [ -n "${hp}" ]; then
    status=$(echo "${hp}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status",""))' 2>/dev/null)
    if [ "${status}" = "connected" ]; then ok "bridge /health -> connected (port ${BRIDGE_PORT})"; else wn "bridge /health -> status='${status}' (gateway may be starting/reconnecting)"; fi
  else
    wn "bridge not answering on 127.0.0.1:${BRIDGE_PORT} — start it with 'hermes gateway run'"
  fi

  # Gateway status (best-effort; read-only)
  if command -v hermes >/dev/null 2>&1; then
    gs=$(hermes gateway status 2>&1 | grep -iE 'whatsapp' | head -1)
    [ -n "${gs}" ] && echo "  INFO  gateway: ${gs}" || echo "  INFO  gateway status reported no whatsapp line (gateway not running?)"
  fi
else
  wn "creds.json absent — NOT yet paired. Interactive step pending: 'hermes whatsapp' (scan QR)."
  echo "  INFO  This is expected immediately after 50-whatsapp.sh; pairing is human-in-the-loop."
fi

echo "=== result: ${pass} pass / ${fail} fail / ${warn} warn ==="
# QR-ready gate: all prerequisite checks must pass. Pairing/live are warnings until the human scans.
if [ "${fail}" -eq 0 ]; then
  if [ -f "${SESSION_DIR}/creds.json" ]; then
    echo "PHASE5_VERIFY_OK (paired)"
  else
    echo "PHASE5_VERIFY_QR_READY (prereqs pass; awaiting QR scan via 'hermes whatsapp')"
  fi
else
  echo "PHASE5_VERIFY_INCOMPLETE"
fi
