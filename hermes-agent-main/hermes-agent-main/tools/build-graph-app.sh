#!/usr/bin/env bash
# Build the static Understand-Anything (UA) "demo-mode" bundle that the dashboard
# embeds at /graph-app/. Demo mode (vite.config.demo.ts → VITE_DEMO_MODE) drops
# UA's token gate and reads the graph from VITE_GRAPH_URL, so the output is a
# fully static site we can serve same-origin with no sidecar.
#
# Usage:
#   tools/build-graph-app.sh [TARGET_DIR]
#
#   TARGET_DIR  where the bundle is written (default: hermes_cli/graph_app next to
#               web_server.py). On mailbox2 use the deployed path, e.g.
#               ~/.hermes/hermes-agent/hermes_cli/graph_app
#
# Env overrides:
#   UA_DASHBOARD   path to the UA plugin's packages/dashboard (autodetected from
#                  the Claude plugin cache if unset)
#   GRAPH_URL      URL the bundle fetches the graph from
#                  (default /graph-app/knowledge-graph.json)
#
# After building, generate the snapshot INTO the same dir (vite empties outDir on
# build, so always: build first, then export the graph):
#   bun run .../gbrain-graph-export.ts --out TARGET_DIR/knowledge-graph.json
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${1:-$REPO_ROOT/hermes_cli/graph_app}"
GRAPH_URL="${GRAPH_URL:-/graph-app/knowledge-graph.json}"

# Locate the UA dashboard package.
if [[ -z "${UA_DASHBOARD:-}" ]]; then
  UA_DASHBOARD="$(ls -d "$HOME"/.claude/plugins/cache/understand-anything/understand-anything/*/packages/dashboard 2>/dev/null | sort -V | tail -1 || true)"
fi
if [[ -z "${UA_DASHBOARD:-}" || ! -f "$UA_DASHBOARD/vite.config.demo.ts" ]]; then
  echo "build-graph-app: cannot find UA dashboard package (set UA_DASHBOARD)." >&2
  echo "  looked under ~/.claude/plugins/cache/understand-anything/.../packages/dashboard" >&2
  exit 2
fi

echo "build-graph-app: UA dashboard = $UA_DASHBOARD"
echo "build-graph-app: target       = $TARGET_DIR"
echo "build-graph-app: graph url     = $GRAPH_URL"

mkdir -p "$TARGET_DIR"

# Build the demo bundle, base-pathed to /graph-app/ so asset URLs resolve under
# the mount. --base overrides the demo config's "/demo/". Skip the package's
# `tsc -b` (workspace typecheck) — vite emits without it.
( cd "$UA_DASHBOARD" \
  && VITE_DEMO_MODE=true VITE_GRAPH_URL="$GRAPH_URL" \
     npx --no-install vite build \
       --config vite.config.demo.ts \
       --base=/graph-app/ \
       --outDir "$TARGET_DIR" \
       --emptyOutDir )

echo "build-graph-app: done → $TARGET_DIR"
echo "build-graph-app: next, write the snapshot:  ... gbrain-graph-export.ts --out $TARGET_DIR/knowledge-graph.json"
