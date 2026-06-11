#!/usr/bin/env bash
#
# Re-deploy the AgentBOX dashboard (frontend + custom backend) to an appliance.
#
# WHY THIS EXISTS
#   `hermes update` (and a fresh box build) leaves the INSTALLED dashboard as
#   stock upstream — it wipes the Carbon reskin / simplified nav (web_dist) and
#   replaces the custom AgentBOX backend (digest endpoint, /dashboard inbox proxy,
#   theme registry, Google/Shopify connect routes) with the stock backend. The
#   stock backend has NO /api/google/* or /api/shopify/* endpoints, so the
#   "Connect Google account" page 404s. Run this after any hermes update, and as
#   the final step of provisioning a NEW box, to install the AgentBOX dashboard.
#
# WHAT IT DOES
#   1. builds web/ (unless --no-build / --backend-only)
#   2. backs up the remote web_dist + every custom backend file it overwrites
#   3. rsyncs the built web_dist -> box (--delete prunes stale assets)
#   4. restores the custom backend — the COMPLETE set of *.py files under
#      hermes_cli/ that diverge from the stock import, derived from git so new
#      custom modules ship automatically (py_compile-checked, stock saved aside)
#   5. restarts hermes-dashboard.service and verifies frontend + backend are live
#
# USAGE
#   bin/deploy-dashboard.sh                       # build + full deploy to default box
#   bin/deploy-dashboard.sh --no-build            # push existing web_dist (skip npm build)
#   bin/deploy-dashboard.sh --backend-only        # only the custom backend (no web build/sync)
#   REMOTE=mailbox2 bin/deploy-dashboard.sh        # agentbox1 (default)
#   REMOTE=UMB@100.127.2.54 \
#     RDIR=/home/UMB/.hermes/hermes-agent/hermes_cli \
#     bin/deploy-dashboard.sh                       # agentbox2
#
# NOTE
#   Restores the CUSTOM backend lineage. If a future hermes update brings backend
#   features you want to keep, merge them into the repo's hermes_cli first — this
#   script does a straight overwrite of the custom file set.
#
set -euo pipefail

REMOTE="${REMOTE:-mailbox2}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES="$REPO/hermes-agent-main/hermes-agent-main"
WEB="$HERMES/web"
CLI="$HERMES/hermes_cli"
# Install root differs per box: agentbox1=mailbox2 has /home/mailbox, agentbox2=UMB
# has /home/UMB. Override RDIR (and REMOTE) to target a different appliance.
RDIR="${RDIR:-/home/mailbox/.hermes/hermes-agent/hermes_cli}"
UNIT="hermes-dashboard.service"
# Backend port the dashboard service listens on (ExecStart: hermes dashboard --port).
PORT="${PORT:-9119}"
TS="$(date +%Y%m%d-%H%M%S)"
# Custom-backend file set: single source of truth shared with the installer.
. "$REPO/bin/lib/custom-backend-files.sh"

build=1
backend_only=0
for arg in "$@"; do
  case "$arg" in
    --no-build)     build=0 ;;
    --backend-only) backend_only=1; build=0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# The COMPLETE custom backend file set (relative to hermes_cli/), from the shared
# source of truth — git-derived, so new custom modules ship automatically.
mapfile -t BACKEND_FILES < <(abx_custom_backend_files "$HERMES")
if [ "${#BACKEND_FILES[@]}" -eq 0 ]; then
  echo "!! Could not determine custom backend file list — aborting" >&2
  exit 1
fi

if [ "$build" = 1 ]; then
  echo "==> Building web ($WEB)"
  ( cd "$WEB" && npm run build )
fi

if [ "$backend_only" = 0 ]; then
  echo "==> Backing up remote web_dist on $REMOTE"
  # SC2029: $RDIR/$TS expand locally (client side) — intentional: they are local vars.
  # shellcheck disable=SC2029
  ssh "$REMOTE" "mkdir -p '$RDIR/_backup_redeploy_$TS' \
    && cp -a '$RDIR/web_dist' '$RDIR/_backup_redeploy_$TS/'"

  echo "==> Syncing web_dist -> $REMOTE"
  rsync -az --delete "$CLI/web_dist/" "$REMOTE:$RDIR/web_dist/"
fi

echo "==> Restoring custom backend (${#BACKEND_FILES[@]} files, syntax-checked) -> $REMOTE"
printf '    %s\n' "${BACKEND_FILES[@]}"

# Build a safely shell-quoted single string for use inside ssh command strings.
# printf '%q ' produces filenames that survive spaces and glob chars unchanged
# for today's clean names, and handles edge cases if names ever change.
BACKEND_FILES_Q=$(printf '%q ' "${BACKEND_FILES[@]}")

# Stage into a per-run temp dir, preserving subdir structure (rsync -R).
RSTAGE="/tmp/agentbox-backend-$TS"
( cd "$CLI" && rsync -aR "${BACKEND_FILES[@]}" "$REMOTE:$RSTAGE/" )

# SC2029: $RDIR/$RSTAGE/$TS/$BACKEND_FILES_Q/$UNIT expand locally — intentional.
# shellcheck disable=SC2029
ssh "$REMOTE" "set -e
  PY='$RDIR/../venv/bin/python3'
  cd '$RSTAGE'
  \$PY -m py_compile $BACKEND_FILES_Q
  for f in $BACKEND_FILES_Q; do
    dst='$RDIR'/\$f
    mkdir -p \"\$(dirname \"\$dst\")\"
    [ -e \"\$dst\" ] && cp -a \"\$dst\" \"\$dst.stock-$TS\" || true
    mv \"$RSTAGE/\$f\" \"\$dst\"
  done
  rm -rf '$RSTAGE'
  systemctl --user restart '$UNIT'
  sleep 4
  echo -n '    service: '; systemctl --user is-active '$UNIT'"

echo "==> Verifying custom backend is live on $REMOTE (port $PORT)"
# SC2029: $RDIR/$PORT expand locally — intentional.
# shellcheck disable=SC2029
if ! ssh "$REMOTE" "'$RDIR/../venv/bin/python3' -c \"import http.client as h; c=h.HTTPConnection('127.0.0.1',$PORT,timeout=10); c.request('GET','/api/google/auth/start'); r=c.getresponse(); print('    /api/google/auth/start ->', r.status); raise SystemExit(0 if r.status in (301,302,303,307,308,200) else 1)\""; then
  echo "!! Backend route not live (still stock or auth-gated) — check $UNIT logs" >&2
  exit 1
fi
echo "    OK: custom backend routes are registered"

echo "==> Verifying deployed backend files match the repo (sha256)"
LOCAL_SUMS=$(cd "$CLI" && sha256sum "${BACKEND_FILES[@]}")
# SC2029: $RDIR/$BACKEND_FILES_Q expand locally — intentional.
# shellcheck disable=SC2029
REMOTE_SUMS=$(ssh "$REMOTE" "cd '$RDIR' && sha256sum $BACKEND_FILES_Q")
if [ "$LOCAL_SUMS" != "$REMOTE_SUMS" ]; then
  echo "FATAL: deployed backend files differ from local set:" >&2
  diff <(printf '%s\n' "$LOCAL_SUMS") <(printf '%s\n' "$REMOTE_SUMS") >&2 || true
  exit 1
fi
echo "    OK: ${#BACKEND_FILES[@]} files verified"

if [ "$backend_only" = 0 ]; then
  echo "==> Verifying served bundle matches local"
  LOCAL_JS="$(grep -o 'assets/index-[^\"]*\.js' "$CLI/web_dist/index.html" | head -1)"
  # SC2029: $RDIR expands locally — intentional.
  # shellcheck disable=SC2029
  REMOTE_JS="$(ssh "$REMOTE" "grep -o 'assets/index-[^\\\"]*\.js' '$RDIR/web_dist/index.html' | head -1")"
  echo "    local : $LOCAL_JS"
  echo "    remote: $REMOTE_JS"
  if [ "$LOCAL_JS" != "$REMOTE_JS" ]; then
    echo "!! MISMATCH — served bundle != local build"; exit 1
  fi
fi

echo "==> OK: AgentBOX dashboard deployed to $REMOTE"
