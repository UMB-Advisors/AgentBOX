#!/usr/bin/env bash
# provision-box.sh — stand up per-box relay reachability for a NEW AgentBOX.
#
# Fleet-provisioning (plan 018, Phase 1). Each box gets its OWN 256-bit token and
# its OWN root-mounted Railway relay service. Root-mount is required because the
# reach-me experience is the box's SPA dashboard, which only renders at a URL root
# (absolute /assets + /api paths). Multiple boxes on ONE relay URL would need
# per-box SUBDOMAINS + a branded/wildcard domain (MBOX-451) — the scale-up later;
# until then, one service per box is the replicable model.
#
# Usage:  ./provision-box.sh <boxid> <ssh-host>
#   <boxid>     box + relay-service key, e.g. agentboxhonduras
#   <ssh-host>  ssh alias/host for the box, e.g. agentboxhonduras
#
# Prereqs (operator machine): `railway login` done; ssh access to the box; node on
# the box. Creating a Railway service is a real (billable) infra action.
# The per-box token is written ONLY to the Railway service env + the box's
# ~/.config/relay-poc/env (mode 600) — never printed, never committed.
set -euo pipefail

BOXID="${1:?usage: ./provision-box.sh <boxid> <ssh-host>}"
SSH_HOST="${2:?usage: ./provision-box.sh <boxid> <ssh-host>}"
RELAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"       # infra/relay-poc
PROJECT_ID="${RELAY_PROJECT_ID:-b9747503-a991-419a-bf2c-36a055b59541}"  # mbox-498-relay-poc
SVC="relay-${BOXID}"
# ssh/scp to the box. Default to key-based BatchMode (standalone operator use). The
# flash engine drives this with password auth by exporting RELAY_SSH/RELAY_SCP
# (e.g. "sshpass -e ssh -o StrictHostKeyChecking=no ...") so a freshly-flashed box
# with no key trust still works. Word-split intentionally (multiple -o flags).
RELAY_SSH="${RELAY_SSH:-ssh -o BatchMode=yes}"
RELAY_SCP="${RELAY_SCP:-scp -o BatchMode=yes}"
log(){ printf '\n\033[1;36m[provision]\033[0m %s\n' "$*"; }
die(){ printf 'provision-box: %s\n' "$*" >&2; exit 1; }

command -v railway >/dev/null || die "railway CLI not found (npm i -g @railway/cli; railway login)"
command -v openssl >/dev/null || die "openssl not found"
[ -f "$RELAY_DIR/server.js" ] || die "run from infra/relay-poc (server.js missing)"

# 1. Per-box token.
TOKEN="$(openssl rand -hex 32)"

# 2. Railway: one root-mounted service per box.
log "Railway: linking project + creating service $SVC"
railway link --project "$PROJECT_ID" >/dev/null 2>&1 \
  || die "railway link failed — run 'railway link' once interactively, then re-run"
if railway status --json 2>/dev/null | grep -q "\"name\":\"$SVC\""; then
  log "  service $SVC already exists — reusing (token/vars NOT rotated; delete it first to re-provision clean)"
else
  railway add --service "$SVC" --variables "BOX_TOKENS=${BOXID}:${TOKEN}" >/dev/null \
    || die "railway add failed"
  railway variables --service "$SVC" --set "SINGLE_BOX=${BOXID}" --skip-deploys >/dev/null 2>&1 || true
fi
log "  deploying relay code to $SVC"
( cd "$RELAY_DIR" && railway up --service "$SVC" --ci >/dev/null ) || die "railway up failed"
railway domain --service "$SVC" >/dev/null 2>&1 || true          # mint a domain if absent
HOST="$(railway domain --service "$SVC" --json 2>/dev/null | python3 -c 'import sys,json,re
try: d=json.load(sys.stdin)
except Exception: sys.exit()
u=d.get("domain") or (d.get("domains") or [{}])[0].get("domain","")
print(re.sub(r"^https?://","",u).rstrip("/"))' 2>/dev/null)"
[ -n "$HOST" ] || die "could not resolve the relay domain for $SVC (check 'railway domain --service $SVC')"
log "  relay host: $HOST"

# 3. Configure the box: env (600), client, systemd user unit. Token via SSH stdin.
log "box: staging client + env on $SSH_HOST"
$RELAY_SSH "$SSH_HOST" 'umask 077; mkdir -p ~/.config/relay-poc ~/relay-poc ~/.config/systemd/user'
$RELAY_SCP "$RELAY_DIR/box-client.js" "$RELAY_DIR/package.json" "$SSH_HOST:~/relay-poc/" >/dev/null
# Install the client's 'ws' dep — NOT silent, NOT '|| true': a missing node or a
# failed install leaves box-client.js (which imports 'ws') crash-looping forever.
$RELAY_SSH "$SSH_HOST" 'command -v node >/dev/null || { echo "node missing on box — run install/onboarding-test-setup.sh first (installs Node 22)"; exit 1; }
  cd ~/relay-poc && npm install --omit=dev --no-audit --no-fund' \
  || die "box-client dependency install failed on $SSH_HOST (needs node + the ws package); the relay client would crash-loop"
# env file — token travels over stdin, never on a command line / in output.
$RELAY_SSH "$SSH_HOST" 'umask 077; cat > ~/.config/relay-poc/env' <<EOF
RELAY_URL=wss://${HOST}
BOX_ID=${BOXID}
BOX_TOKEN=${TOKEN}
ORIGIN=http://127.0.0.1:9200
EOF
$RELAY_SSH "$SSH_HOST" 'cat > ~/.config/systemd/user/relay-poc.service <<UNIT
[Unit]
Description=AgentBOX relay client (dials the per-box relay)
# network-online.target is INERT in the --user instance (nothing pulls it in), so
# a user unit that Wants/After it would start immediately at user-manager boot
# anyway. Order on the plain network.target and rely on box-client.js reconnect
# backoff to ride out an early start rather than pretend to wait for the network.
After=network.target
[Service]
ExecStart=/usr/bin/node %h/relay-poc/box-client.js
EnvironmentFile=%h/.config/relay-poc/env
Restart=always
RestartSec=2
NoNewPrivileges=true
[Install]
WantedBy=default.target
UNIT
loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable --now relay-poc'

# 4. Verify the box registered on the relay.
log "verify: relay sees the box"
ok=""
# `railway up --ci` returns at BUILD submit, not deploy-live, so the relay may take
# tens of seconds to start serving. Poll for up to ~90s before giving up.
for _ in $(seq 1 30); do
  if curl -s --max-time 6 "https://${HOST}/__relay/health" | grep -q "\"${BOXID}\""; then ok=1; break; fi
  sleep 3
done
[ -n "$ok" ] || die "box did not register on https://${HOST} within ~90s — the Railway deploy may still be building (check 'railway logs --service $SVC') or the box client is down (check '$RELAY_SSH $SSH_HOST journalctl --user -u relay-poc -n 30')"

# Registered != proxying. Confirm the tunnel actually REACHES the box sidecar (:9200)
# so a registered-but-not-proxying box fails loudly instead of false-greening.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 -H "Authorization: Bearer ${TOKEN}" "https://${HOST}/")
case "$code" in
  200) log "  proxy OK — relay reaches the box sidecar :9200 [HTTP $code]" ;;
  502|503) die "box registered but the relay CANNOT reach the box sidecar :9200 [HTTP $code] — is agentbox-sidecar up? check ':9200/healthz' + 'journalctl --user -u relay-poc' on $SSH_HOST" ;;
  *) log "  WARN: unexpected proxy response [HTTP $code] — verify the sidecar + box-client on $SSH_HOST manually" ;;
esac

log "DONE — box '${BOXID}' provisioned."
echo "  reach-me URL (the box's sidecar builds it for the wizard; token is in the box env):"
echo "    https://${HOST}/?key=<BOX_TOKEN from ~/.config/relay-poc/env on ${SSH_HOST}>"
echo "  the onboarding complete step will show this as a link + QR automatically."
