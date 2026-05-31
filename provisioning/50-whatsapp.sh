#!/usr/bin/env bash
# hermesBOX — Phase 5: WhatsApp gateway (Baileys bridge) → QR-ready state.
# Gets deps installed, session dir ready, allowlist + env set, and the gateway
# configured to load the WhatsApp platform. STOPS before the QR scan: pairing
# (`hermes whatsapp`) is interactive and must be run by a human in a real TTY.
#
# Idempotent. Safe to re-run. Does NOT start/restart services or pair.
# Spec: docs/PRD-v1.0.0.md §8 Phase 5 · docs/ROADMAP-v1.0.0.md · Linear UMB-384
#
# DRIFT NOTE (load-bearing): the PRD assumes a whatsapp-web.js + chromium/puppeteer
# bridge (~0.4–0.7 GB chromium). The SHIPPED bridge (hermes-agent v0.15.1) uses
# **Baileys** — a pure-WebSocket WhatsApp Web client with NO Chromium/Puppeteer
# dependency (confirmed: package-lock.json has no puppeteer/chromium; upstream
# docs state "does not require a local Chromium or Puppeteer dependency stack").
# Real footprint is one Node process (~50–90 MB RSS). This script therefore does
# NOT install chromium-arm64. ffmpeg (present on box) is used only for optional
# voice-note transcoding and degrades gracefully if absent.
set -euo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true

HH="${HERMES_HOME:-$HOME/.hermes}"
BRIDGE_DIR="${HH}/hermes-agent/scripts/whatsapp-bridge"   # bundled with the install
SESSION_DIR="${HH}/platforms/whatsapp/session"            # path the gateway passes via --session
ENV_FILE="${HH}/.env"
CFG_FILE="${HH}/config.yaml"

# --- Human-in-the-loop input -------------------------------------------------
# Allowlisted WhatsApp number(s): comma-separated, country code, NO '+'.
# e.g. HERMESBOX_WA_ALLOWED="15551234567" (or "*" for open bot — not recommended).
# Empty == deny-all (the bridge's secure default; pairing flow still available).
WA_ALLOWED="${HERMESBOX_WA_ALLOWED:-}"
# Mode: "self-chat" (single user, message yourself) or "bot" (dedicated number).
WA_MODE="${HERMESBOX_WA_MODE:-self-chat}"

log() { printf '\n\033[1;36m[phase5-whatsapp]\033[0m %s\n' "$*"; }

# --- 0. Sanity: bridge + node present ---------------------------------------
log "0/5 — preflight (node, npm, bridge script)"
command -v node >/dev/null 2>&1 || { echo "node not on PATH (Phase 0 prereq)"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "npm not on PATH (Phase 0 prereq)";  exit 1; }
echo "node $(node -v) · npm $(npm -v)"
[ -f "${BRIDGE_DIR}/bridge.js" ] || { echo "bridge.js not found at ${BRIDGE_DIR} — is hermes-agent installed?"; exit 1; }
command -v ffmpeg >/dev/null 2>&1 && echo "ffmpeg present ($(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')) — voice notes enabled" \
  || echo "ffmpeg absent — voice-note transcoding will fall back to file attachment (non-fatal)"

# --- 1. Install bridge deps (deterministic, pinned via lockfile) ------------
log "1/5 — install Baileys bridge dependencies (npm ci, no chromium)"
if [ -d "${BRIDGE_DIR}/node_modules" ] && \
   node -e "require('${BRIDGE_DIR}/node_modules/@whiskeysockets/baileys')" >/dev/null 2>&1; then
  echo "node_modules already present and baileys importable — skipping install"
else
  # npm ci honours package-lock.json exactly (pinned commit of Baileys + express/pino/qrcode-terminal).
  ( cd "${BRIDGE_DIR}" && npm ci --no-audit --no-fund )
fi
echo "--- installed bridge deps ---"
( cd "${BRIDGE_DIR}" && node -e "const p=require('./package.json'); console.log(Object.keys(p.dependencies).join(', '))" )

# --- 2. Session directory (creds.json lands here after pairing) -------------
log "2/5 — prepare session dir (mode 700) at ${SESSION_DIR}"
mkdir -p "${SESSION_DIR}"
chmod 700 "${SESSION_DIR}" "${HH}/platforms" "${HH}/platforms/whatsapp" 2>/dev/null || true
if [ -f "${SESSION_DIR}/creds.json" ]; then
  echo "creds.json already present — box is ALREADY PAIRED (QR scan not needed)"
else
  echo "no creds.json yet — pairing required (interactive, see next-steps below)"
fi

# --- 3. Env vars in ~/.hermes/.env (preserve existing keys; chmod 600) ------
log "3/5 — set WHATSAPP_ENABLED / WHATSAPP_MODE / WHATSAPP_ALLOWED_USERS in ${ENV_FILE}"
umask 077
touch "${ENV_FILE}"
# Idempotent upsert: replace the line if present, else append.
upsert_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "${ENV_FILE}"; then
    # Use a tmp file so we never partially rewrite the secrets file.
    awk -v k="${key}" -v v="${val}" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' "${ENV_FILE}" > "${ENV_FILE}.tmp"
    mv "${ENV_FILE}.tmp" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${val}" >> "${ENV_FILE}"
  fi
}
upsert_env "WHATSAPP_ENABLED" "true"
upsert_env "WHATSAPP_MODE"    "${WA_MODE}"
if [ -n "${WA_ALLOWED}" ]; then
  upsert_env "WHATSAPP_ALLOWED_USERS" "${WA_ALLOWED}"
  echo "allowlist set: WHATSAPP_ALLOWED_USERS=${WA_ALLOWED}"
else
  # Do NOT write an empty allowlist that looks intentional; leave a clearly-marked
  # placeholder so the operator knows a number is still required. Deny-all until set.
  if ! grep -qE '^WHATSAPP_ALLOWED_USERS=' "${ENV_FILE}"; then
    printf '# WHATSAPP_ALLOWED_USERS=  # REQUIRED: phone number(s), country code, no "+". "*"=open bot. Empty=deny-all.\n' >> "${ENV_FILE}"
  fi
  echo "NOTE: no allowlist provided (HERMESBOX_WA_ALLOWED unset) — incoming messages are DENIED until you set WHATSAPP_ALLOWED_USERS."
fi
chmod 600 "${ENV_FILE}"

# --- 4. config.yaml: silence stranger DMs on a private number (idempotent) --
log "4/5 — config.yaml: set whatsapp.unauthorized_dm_behavior: ignore (private-number default)"
touch "${CFG_FILE}"
if grep -qE '^[[:space:]]*whatsapp:' "${CFG_FILE}"; then
  echo "a 'whatsapp:' block already exists in config.yaml — leaving as-is (manual review if behavior differs)"
else
  cp "${CFG_FILE}" "${CFG_FILE}.prewhatsapp" 2>/dev/null || true
  cat >> "${CFG_FILE}" <<'YAML'

# hermesBOX Phase 5 — WhatsApp behaviour. Bridge enabled via WHATSAPP_ENABLED in .env.
# 'ignore' keeps a private number silent to strangers instead of emitting a pairing code.
whatsapp:
  unauthorized_dm_behavior: "ignore"
  # reply_prefix: ""   # uncomment to drop the "⚕ Hermes Agent" header on replies
YAML
  echo "appended whatsapp block to config.yaml (backup: config.yaml.prewhatsapp)"
fi

# --- 5. Summary --------------------------------------------------------------
log "5/5 — QR-ready state reached. Pairing is the remaining interactive step."
cat <<EOF

============================================================================
 hermesBOX WhatsApp — provisioning complete (QR-READY, NOT yet paired)
============================================================================
 Bridge      : Baileys (pure WebSocket, no Chromium) — deps installed
 Bridge dir  : ${BRIDGE_DIR}
 Session dir : ${SESSION_DIR}  (mode 700; creds.json appears after pairing)
 .env        : WHATSAPP_ENABLED=true · WHATSAPP_MODE=${WA_MODE} · allowlist=$( [ -n "${WA_ALLOWED}" ] && echo "${WA_ALLOWED}" || echo "UNSET (deny-all)" )
 config.yaml : whatsapp.unauthorized_dm_behavior=ignore

 >>> HUMAN-IN-THE-LOOP — QR PAIRING (run in a REAL TTY, not this script) <<<
   1. If not already set, choose your allowlisted number(s) and add to .env:
        WHATSAPP_ALLOWED_USERS=<countrycode><number>   # e.g. 15551234567, no "+"
        (re-run with HERMESBOX_WA_ALLOWED=15551234567 to set it automatically)
   2. SSH in with a TTY:   ssh -t mailbox@mailbox2.tail377a9a.ts.net
   3. Source env & pair:   source ~/.hermesbox_env.sh && hermes whatsapp
      -> pick mode (${WA_MODE}); a QR code prints in the terminal.
   4. On your phone: WhatsApp > Settings > Linked Devices > Link a Device,
      then scan the QR. Wizard confirms "WhatsApp connected!" and saves the session.
      (Terminal must be >= 60 cols and Unicode-capable for the QR to render.)
   5. Bring the platform online:  hermes gateway run   (foreground; or 'install' for a service)
      The gateway auto-launches the bridge using the saved session.

 Then verify:  bash provisioning/verify-phase5.sh
============================================================================
EOF
echo "PHASE5_PROVISION_DONE"
