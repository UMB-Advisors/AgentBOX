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

# ── Deploy coordination (see CLAUDE.md "Deploy Coordination — Simultaneous
# Builds"). Concurrent agents racing this script clobber each other's web_dist
# (last-writer-wins). Serialize deploys to a given box on THIS machine with a
# flock, then re-exec holding the lock. Cross-machine staleness is caught by the
# origin/main freshness check + the DEPLOY_META forward-only guard further down.
if [ -z "${_ABX_DEPLOY_LOCKED:-}" ]; then
  _ABX_LOCK="${TMPDIR:-/tmp}/agentbox-deploy-$(printf '%s' "$REMOTE" | tr -c 'A-Za-z0-9' '_').lock"
  echo "==> Acquiring deploy lock ($_ABX_LOCK) — waits if a peer deploy holds it"
  exec env _ABX_DEPLOY_LOCKED=1 flock --timeout 900 "$_ABX_LOCK" "$0" "$@"
fi

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
force=0
for arg in "$@"; do
  case "$arg" in
    --no-build)     build=0 ;;
    --backend-only) backend_only=1; build=0 ;;
    --force)        force=1 ;;  # bypass freshness + forward-only guards
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

# ── Freshness guard: the deploy source must CONTAIN origin/main, otherwise a
# stale checkout silently reverts newer work (the 2026-06-09 Org Chart squash).
# Override with --force.
if [ "$force" = 0 ]; then
  echo "==> Freshness check: HEAD must contain origin/main"
  git -C "$REPO" fetch origin --quiet \
    || { echo "!! git fetch origin failed — fix connectivity or pass --force" >&2; exit 1; }
  if ! git -C "$REPO" merge-base --is-ancestor origin/main HEAD; then
    echo "!! ABORT: HEAD is behind/divergent from origin/main — deploying would clobber newer work." >&2
    echo "   Fix: git checkout main && git pull   then re-deploy.   Override: --force" >&2
    exit 1
  fi
fi

if [ "$build" = 1 ]; then
  echo "==> Building web ($WEB)"
  ( cd "$WEB" && npm run build )
fi

if [ "$backend_only" = 0 ]; then
  # ── Forward-only guard: if the box already serves a deploy our HEAD does NOT
  # contain, we'd be reverting it — refuse unless --force. DEPLOY_META is shipped
  # inside web_dist (below) so it survives the next rsync --delete.
  if [ "$force" = 0 ]; then
    LIVE_SHA="$(ssh "$REMOTE" "sed -n 's/^sha=//p' '$RDIR/web_dist/DEPLOY_META' 2>/dev/null" || true)"
    if [ -n "${LIVE_SHA:-}" ] && ! git -C "$REPO" merge-base --is-ancestor "$LIVE_SHA" HEAD 2>/dev/null; then
      echo "!! ABORT: $REMOTE serves a newer/divergent deploy ($LIVE_SHA) your HEAD lacks." >&2
      echo "   Deploying would REVERT it. Pull/rebase first, or override with --force." >&2
      exit 1
    fi
  fi

  # Provenance stamp — read by the forward-only guard on the next deploy.
  _SHA="$(git -C "$REPO" rev-parse HEAD)"
  _BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
  if git -C "$REPO" diff --quiet && git -C "$REPO" diff --cached --quiet; then _DIRTY=false; else _DIRTY=true; fi
  printf 'sha=%s\nbranch=%s\ndirty=%s\nby=%s@%s\nat=%s\n' \
    "$_SHA" "$_BRANCH" "$_DIRTY" "$(whoami)" "$(hostname)" "$(date -u +%FT%TZ)" \
    > "$CLI/web_dist/DEPLOY_META"

  echo "==> Backing up remote web_dist on $REMOTE"
  ssh "$REMOTE" "mkdir -p '$RDIR/_backup_redeploy_$TS' \
    && cp -a '$RDIR/web_dist' '$RDIR/_backup_redeploy_$TS/'"

  echo "==> Syncing web_dist -> $REMOTE (HEAD $_SHA, dirty=$_DIRTY)"
  rsync -az --delete "$CLI/web_dist/" "$REMOTE:$RDIR/web_dist/"
fi

echo "==> Restoring custom backend (${#BACKEND_FILES[@]} files, syntax-checked) -> $REMOTE"
printf '    %s\n' "${BACKEND_FILES[@]}"

# Stage into a per-run temp dir, preserving subdir structure (rsync -R).
RSTAGE="/tmp/agentbox-backend-$TS"
( cd "$CLI" && rsync -aR "${BACKEND_FILES[@]}" "$REMOTE:$RSTAGE/" )

ssh "$REMOTE" "set -e
  PY='$RDIR/../venv/bin/python3'
  cd '$RSTAGE'
  \$PY -m py_compile ${BACKEND_FILES[*]}
  for f in ${BACKEND_FILES[*]}; do
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
ssh "$REMOTE" "'$RDIR/../venv/bin/python3' -c \"import http.client as h; c=h.HTTPConnection('127.0.0.1',$PORT,timeout=10); c.request('GET','/api/google/auth/start'); r=c.getresponse(); print('    /api/google/auth/start ->', r.status); raise SystemExit(0 if r.status in (301,302,303,307,308,200) else 1)\"" \
  && echo "    OK: custom backend routes are registered" \
  || { echo "!! Backend route not live (still stock or auth-gated) — check $UNIT logs"; exit 1; }

if [ "$backend_only" = 0 ]; then
  echo "==> Verifying served bundle matches local"
  LOCAL_JS="$(grep -o 'assets/index-[^\"]*\.js' "$CLI/web_dist/index.html" | head -1)"
  REMOTE_JS="$(ssh "$REMOTE" "grep -o 'assets/index-[^\\\"]*\.js' '$RDIR/web_dist/index.html' | head -1")"
  echo "    local : $LOCAL_JS"
  echo "    remote: $REMOTE_JS"
  if [ "$LOCAL_JS" != "$REMOTE_JS" ]; then
    echo "!! MISMATCH — served bundle != local build"; exit 1
  fi
fi

echo "==> OK: AgentBOX dashboard deployed to $REMOTE"
