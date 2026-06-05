#!/usr/bin/env bash
#
# Re-deploy the AgentBOX dashboard (frontend + custom backend) to mailbox2.
#
# WHY THIS EXISTS
#   `hermes update` resets the INSTALLED dashboard to stock upstream — it wipes
#   the Carbon reskin / simplified nav (web_dist) and replaces the custom
#   AgentBOX web_server.py (digest endpoint + /dashboard inbox proxy + theme
#   registry) with the stock 7751-line backend. Run this after any hermes
#   update to restore the AgentBOX dashboard.
#
# WHAT IT DOES
#   1. builds web/ (unless --no-build)
#   2. backs up the remote web_dist + web_server.py
#   3. rsyncs the built web_dist -> mailbox2 (--delete prunes stale assets)
#   4. restores the custom web_server.py (py_compile-checked, stock saved aside)
#   5. restarts hermes-dashboard.service and verifies the served bundle matches
#
# USAGE
#   bin/deploy-dashboard.sh             # build + full deploy
#   bin/deploy-dashboard.sh --no-build  # push existing web_dist (skip npm build)
#   REMOTE=mailbox2 bin/deploy-dashboard.sh
#
# NOTE
#   This restores the CUSTOM backend lineage. If a future hermes update brings
#   backend features you want to keep, merge them into the repo's web_server.py
#   instead of relying on this script's straight restore.
#
set -euo pipefail

REMOTE="${REMOTE:-mailbox2}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$REPO/hermes-agent-main/hermes-agent-main/web"
CLI="$REPO/hermes-agent-main/hermes-agent-main/hermes_cli"
RDIR="/home/mailbox/.hermes/hermes-agent/hermes_cli"
UNIT="hermes-dashboard.service"
TS="$(date +%Y%m%d-%H%M%S)"

build=1
[ "${1:-}" = "--no-build" ] && build=0

if [ "$build" = 1 ]; then
  echo "==> Building web ($WEB)"
  ( cd "$WEB" && npm run build )
fi

echo "==> Backing up remote web_dist + web_server.py on $REMOTE"
ssh "$REMOTE" "mkdir -p '$RDIR/_backup_redeploy_$TS' \
  && cp -a '$RDIR/web_dist' '$RDIR/_backup_redeploy_$TS/' \
  && cp -a '$RDIR/web_server.py' '$RDIR/_backup_redeploy_$TS/web_server.py'"

echo "==> Syncing web_dist -> $REMOTE"
rsync -az --delete "$CLI/web_dist/" "$REMOTE:$RDIR/web_dist/"

echo "==> Restoring custom backend (web_server.py + google_brief.py, syntax-checked) -> $REMOTE"
scp -q "$CLI/web_server.py" "$REMOTE:/tmp/web_server.deploy.py"
scp -q "$CLI/google_brief.py" "$REMOTE:/tmp/google_brief.deploy.py"
ssh "$REMOTE" "set -e
  '$RDIR/../venv/bin/python3' -m py_compile /tmp/web_server.deploy.py /tmp/google_brief.deploy.py
  cp -a '$RDIR/web_server.py' '$RDIR/web_server.py.stock-$TS' 2>/dev/null || true
  cp -a '$RDIR/google_brief.py' '$RDIR/google_brief.py.stock-$TS' 2>/dev/null || true
  mv /tmp/web_server.deploy.py '$RDIR/web_server.py'
  mv /tmp/google_brief.deploy.py '$RDIR/google_brief.py'
  systemctl --user restart '$UNIT'
  sleep 3
  systemctl --user is-active '$UNIT'"

echo "==> Verifying served bundle matches local"
LOCAL_JS="$(grep -o 'assets/index-[^\"]*\.js' "$CLI/web_dist/index.html" | head -1)"
REMOTE_JS="$(ssh "$REMOTE" "grep -o 'assets/index-[^\\\"]*\.js' '$RDIR/web_dist/index.html' | head -1")"
echo "    local : $LOCAL_JS"
echo "    remote: $REMOTE_JS"
if [ "$LOCAL_JS" = "$REMOTE_JS" ]; then
  echo "==> OK: dashboard re-deployed ($REMOTE serving $REMOTE_JS)"
  echo "    Phone:  https://mailbox2.tail377a9a.ts.net   (basic auth: user / see ~/agentbox-basicauth.txt)"
  echo "    Tunnel: ssh -L 9119:localhost:9119 $REMOTE   then http://localhost:9119"
else
  echo "!! MISMATCH — served bundle != local build"; exit 1
fi
