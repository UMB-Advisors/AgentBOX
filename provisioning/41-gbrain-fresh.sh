#!/usr/bin/env bash
# hermesBOX — Phase 4 (fresh-brain variant): gbrain memory over MCP, SEPARATE brain.
# User chose a FRESH brain (not repurposing ~/.gbrain). Uses GBRAIN_HOME=~/.hermesbox
# so the brain lives at ~/.hermesbox/.gbrain — the existing ~/.gbrain is never touched.
# Runs gbrain via `bun run` (no fragile arm64 compile). Local Ollama embeddings.
# Spec: PRD-ADDENDUM-001 DR-009 · Linear UMB-383. Idempotent.
set -euo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true

GBRAIN_SRC="${GBRAIN_SRC:-$HOME/gbrain-src}"        # rsync gbrain-master/ here first
export GBRAIN_HOME="${GBRAIN_HOME:-$HOME/.hermesbox}"
BUN="$HOME/.bun/bin/bun"
CLI="$GBRAIN_SRC/src/cli.ts"
OLLAMA_V1="http://127.0.0.1:11434/v1"               # gbrain ollama recipe needs the /v1 suffix
EMBED="ollama:nomic-embed-text"                     # 768-dim, local (DR-009)
HH="$HOME/.hermes"
log(){ printf '\n\033[1;36m[phase4-gbrain]\033[0m %s\n' "$*"; }

[ -d "$GBRAIN_SRC" ] || { echo "gbrain source missing at $GBRAIN_SRC — rsync gbrain-master/ there first"; exit 1; }

log "1/4 — bun install gbrain deps (fast; no compile)"
( cd "$GBRAIN_SRC" && "$BUN" install --frozen-lockfile 2>/dev/null || "$BUN" install )
echo "gbrain: $("$BUN" run "$CLI" --version 2>/dev/null | tail -1)"

log "2/4 — init FRESH pglite brain at $GBRAIN_HOME/.gbrain (Ollama embeddings)"
export OLLAMA_BASE_URL="$OLLAMA_V1"
if [ ! -f "$GBRAIN_HOME/.gbrain/config.json" ]; then
  "$BUN" run "$CLI" init --pglite --embedding-model "$EMBED" 2>&1 | tail -3
fi
# Persist the /v1 ollama base into the brain config (so it works without env too)
python3 - "$GBRAIN_HOME/.gbrain/config.json" "$OLLAMA_V1" <<'PY'
import json,sys
p,u=sys.argv[1],sys.argv[2]
c=json.load(open(p))
c.setdefault("base_urls",{})["ollama"]=u
c.setdefault("provider_base_urls",{})["ollama"]=u
json.dump(c,open(p,"w"),indent=2)
print("brain config:",c.get("embedding_model"),c.get("embedding_dimensions"),"ollama->",u)
PY
[ -d "$HOME/.gbrain/brain.pglite" ] && echo "existing ~/.gbrain preserved (untouched)"

log "3/4 — register gbrain as an MCP server in hermes (env carries GBRAIN_HOME + /v1 ollama)"
cp "$HH/config.yaml" "$HH/config.yaml.premcp" 2>/dev/null || true
if ! grep -q "^mcp_servers:" "$HH/config.yaml"; then
cat >> "$HH/config.yaml" <<YAML

# gbrain memory (Phase 4) — fresh brain at GBRAIN_HOME, local Ollama embeddings
mcp_servers:
  gbrain:
    command: $BUN
    args: ["run", "$CLI", "serve"]
    env:
      GBRAIN_HOME: $GBRAIN_HOME
      OLLAMA_BASE_URL: $OLLAMA_V1
YAML
  echo "appended mcp_servers.gbrain"
else
  echo "mcp_servers already present — verify it points at gbrain ($CLI)"
fi

log "4/4 — smoke: put a page, hybrid query, confirm hermes sees the MCP tools"
printf "# hermesBOX\nThe hermesBOX appliance runs on an NVIDIA Jetson Orin Nano 8GB (JetPack 6.2), cloud Codex inference, gbrain memory.\n" | "$BUN" run "$CLI" put hermesbox-test >/dev/null 2>&1 || true
"$BUN" run "$CLI" query "what hardware does hermesbox run on" 2>&1 | tail -3
hermes mcp list 2>&1 | grep -i gbrain || echo "WARN: gbrain not in 'hermes mcp list'"
echo "PHASE4_GBRAIN_DONE"
