#!/usr/bin/env bash
# hermesBOX — Phase 4: gbrain memory over MCP (idempotent)
# Builds gbrain (bun-linux-arm64), registers it as an mcp_server in hermes-agent,
# and points its embedding backend at the local Ollama nomic-embed-text model.
# PRESERVES the existing brain at ~/.gbrain/brain.pglite (no clobber, no reindex here).
# Runs AS the appliance user (mailbox) on the box. Safe to re-run.
# Spec: docs/ROADMAP-v1.0.0.md Phase 4 · docs/PRD-ADDENDUM-001-cloud-inference.md (DR-003/DR-009) · Linear UMB-383
set -euo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true

# Pinned versions / paths (Constitution §4 — exact pins, no ranges)
GBRAIN_VERSION="0.41.38.0"                 # matches repo VERSION shipped to the box
BUN_TARGET="bun-linux-arm64"               # Orin Nano is aarch64; upstream build:all omits this target
EMBED_MODEL="ollama:nomic-embed-text"      # DR-003/DR-009: local Ollama embeddings
EMBED_DIMS="768"                           # nomic-embed-text native dim (ollama recipe default_dims)
OLLAMA_URL="http://127.0.0.1:11434/v1"     # local, on-box; ollama recipe base_url shape ends in /v1

HH="${HERMES_HOME:-$HOME/.hermes}"
GH="${GBRAIN_HOME:-$HOME/.gbrain}"
GBRAIN_SRC="${GBRAIN_SRC:-$HOME/gbrain-src}"      # source tree synced to the box (main agent rsyncs gbrain-master here)
GBRAIN_BIN="${GBRAIN_BIN:-$HOME/.local/bin/gbrain}"
BUN="${HOME}/.bun/bin/bun"
STAMP="$(date +%Y%m%d-%H%M%S)"

log() { printf '\n\033[1;36m[phase4-gbrain]\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# 0/6 — Preconditions (read-only assertions; fail loud, mutate nothing yet)
# ---------------------------------------------------------------------------
log "0/6 — preconditions"
[ -x "$BUN" ] || { echo "bun not found at $BUN (expected 1.3.14)"; exit 1; }
echo "bun: $("$BUN" --version)"
curl -fsS "${OLLAMA_URL%/v1}/api/version" >/dev/null 2>&1 \
  || { echo "Ollama not reachable at ${OLLAMA_URL%/v1} — start it before Phase 4"; exit 1; }
ollama list 2>/dev/null | grep -q '^nomic-embed-text' \
  || { echo "nomic-embed-text not pulled (run 22-cloud-config.sh first)"; exit 1; }
[ -d "$GBRAIN_SRC" ] || { echo "gbrain source not present at $GBRAIN_SRC — rsync gbrain-master/ there first"; exit 1; }
have hermes || { echo "hermes-agent not installed (Phase 2)"; exit 1; }

# ---------------------------------------------------------------------------
# 1/6 — Back up the EXISTING brain + config BEFORE touching anything (HARD RULE)
# ---------------------------------------------------------------------------
log "1/6 — back up existing brain + gbrain config (idempotent, never overwrites a prior backup)"
if [ -d "$GH/brain.pglite" ]; then
  # Copy-on-first-run only; we never clobber a backup we already took.
  if [ ! -e "$GH/brain.pglite.prehermesbox" ]; then
    cp -a "$GH/brain.pglite" "$GH/brain.pglite.prehermesbox"
    echo "backed up brain.pglite -> brain.pglite.prehermesbox ($(du -sh "$GH/brain.pglite.prehermesbox" | cut -f1))"
  else
    echo "brain.pglite.prehermesbox already exists — leaving the original backup intact"
  fi
else
  echo "WARNING: no existing brain at $GH/brain.pglite (a fresh brain will be created on first write)"
fi
if [ -f "$GH/config.json" ] && [ ! -f "$GH/config.json.prehermesbox" ]; then
  cp -a "$GH/config.json" "$GH/config.json.prehermesbox"
  echo "backed up config.json -> config.json.prehermesbox"
fi

# Record what the existing brain was embedded with (load-bearing — see 4/6).
EXISTING_MODEL="$(grep -oE '"embedding_model"[^,]*' "$GH/config.json" 2>/dev/null | sed -E 's/.*:\s*"([^"]*)".*/\1/' || true)"
EXISTING_DIMS="$(grep -oE '"embedding_dimensions"\s*:\s*[0-9]+' "$GH/config.json" 2>/dev/null | grep -oE '[0-9]+' || true)"
echo "existing brain embedding_model=${EXISTING_MODEL:-<none>} dims=${EXISTING_DIMS:-<none>}"

# ---------------------------------------------------------------------------
# 2/6 — Build the gbrain arm64 binary (additive; nothing on the brain changes)
# ---------------------------------------------------------------------------
log "2/6 — build gbrain ${GBRAIN_VERSION} for ${BUN_TARGET}"
if [ -x "$GBRAIN_BIN" ] && "$GBRAIN_BIN" --version 2>/dev/null | grep -q "$GBRAIN_VERSION"; then
  echo "gbrain ${GBRAIN_VERSION} already built at $GBRAIN_BIN"
else
  echo "installing gbrain dependencies (bun install --frozen-lockfile)"
  ( cd "$GBRAIN_SRC" && "$BUN" install --frozen-lockfile )
  mkdir -p "$(dirname "$GBRAIN_BIN")"
  echo "compiling -> $GBRAIN_BIN (target ${BUN_TARGET})"
  # Upstream build:all lacks a linux-arm64 target; compile one explicitly for the Orin.
  ( cd "$GBRAIN_SRC" && "$BUN" build --compile --target="$BUN_TARGET" --outfile "$GBRAIN_BIN" src/cli.ts )
  chmod +x "$GBRAIN_BIN"
fi
echo "gbrain: $("$GBRAIN_BIN" --version 2>/dev/null || echo 'version probe failed')"

# ---------------------------------------------------------------------------
# 3/6 — Point gbrain embeddings at local Ollama nomic-embed-text
# ---------------------------------------------------------------------------
# config.ts findings: embedding_model / embedding_dimensions are FILE-PLANE
# canonical (~/.gbrain/config.json) and set at init. `gbrain config set
# embedding_model ...` writes the DB plane and is a SILENT NO-OP for the embed
# pipeline. So we edit config.json directly (atomic write via tmp+mv), preserving
# every other key (database_path, engine, the existing brain pointer, etc.).
log "3/6 — set gbrain embedding provider -> ${EMBED_MODEL} (${EMBED_DIMS} dims) via local Ollama"
if [ ! -f "$GH/config.json" ]; then
  echo "no config.json present; gbrain init will create one — re-run after init"; exit 1
fi
# Use bun (already pinned) for a safe JSON merge rather than fragile sed.
TMP_CFG="$(mktemp "${GH}/.config.json.XXXXXX")"
EMBED_MODEL="$EMBED_MODEL" EMBED_DIMS="$EMBED_DIMS" OLLAMA_URL="$OLLAMA_URL" \
  "$BUN" -e '
    const fs = require("fs");
    const p = process.env.HOME + "/.gbrain/config.json";
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    cfg.embedding_model = process.env.EMBED_MODEL;
    cfg.embedding_dimensions = parseInt(process.env.EMBED_DIMS, 10);
    cfg.base_urls = Object.assign({}, cfg.base_urls, { ollama: process.env.OLLAMA_URL });
    cfg.provider_base_urls = Object.assign({}, cfg.provider_base_urls, { ollama: process.env.OLLAMA_URL });
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
  ' > "$TMP_CFG"
chmod 600 "$TMP_CFG"
mv -f "$TMP_CFG" "$GH/config.json"
echo "config.json now:"; grep -E '"embedding_model"|"embedding_dimensions"|"ollama"' "$GH/config.json"

# ---------------------------------------------------------------------------
# 4/6 — Dimension-coherence guard (DO NOT silently re-embed the existing brain)
# ---------------------------------------------------------------------------
# The existing brain was built with embedding_dimensions=${EXISTING_DIMS}.
# nomic-embed-text emits ${EMBED_DIMS}. If they differ, gbrain's embed/reindex
# pipeline throws EmbeddingDimMismatchError and REFUSES to write — by design.
# Re-embedding every chunk (gbrain reindex --markdown --fresh) MUTATES the brain's
# vectors and is therefore the only destructive action in this phase. We DO NOT
# run it automatically. It is a HUMAN-IN-THE-LOOP gate (see verify + structured
# output). New pages written from now on embed cleanly at ${EMBED_DIMS}.
log "4/6 — dimension-coherence check"
if [ -n "${EXISTING_DIMS:-}" ] && [ "${EXISTING_DIMS}" != "${EMBED_DIMS}" ]; then
  cat <<WARN
  ┌─ ATTENTION ─────────────────────────────────────────────────────────────┐
  │ Existing brain vectors are ${EXISTING_DIMS}-dim (${EXISTING_MODEL}).
  │ New embedding model is ${EMBED_DIMS}-dim (${EMBED_MODEL}).
  │ Vector search over PRE-EXISTING pages will be incoherent until a reindex
  │ re-embeds them at ${EMBED_DIMS}. gbrain will REFUSE mixed-dim embeds
  │ (EmbeddingDimMismatchError) — this is the safety rail, not a bug.
  │
  │ This script does NOT reindex (it would re-embed/overwrite vectors).
  │ To re-embed (operator decision, brain backed up at brain.pglite.prehermesbox):
  │     gbrain reindex --markdown --fresh
  │ Keyword/FTS search keeps working on the old pages regardless.
  └──────────────────────────────────────────────────────────────────────────┘
WARN
else
  echo "dims match (${EMBED_DIMS}) — no reindex needed"
fi

# ---------------------------------------------------------------------------
# 5/6 — Register gbrain as an MCP server in hermes-agent (additive, backed up)
# ---------------------------------------------------------------------------
# hermes-agent mcp_servers schema (tools/mcp_tool.py): per-server {command, args, env}.
# stdio MCP entry is `gbrain serve` (src/commands/serve.ts -> startMcpServer).
# _build_safe_env() only forwards PATH/HOME/USER/LANG/.../XDG_* PLUS the per-server
# `env` block, so OLLAMA_BASE_URL / GBRAIN_* must be declared here to reach the
# subprocess. HOME is preserved, so ~/.gbrain (and the existing brain) resolves.
log "5/6 — register gbrain as an mcp_server in ${HH}/config.yaml"
mkdir -p "$HH"
if [ -f "$HH/config.yaml" ] && [ ! -f "$HH/config.yaml.prephase4" ]; then
  cp -a "$HH/config.yaml" "$HH/config.yaml.prephase4"
  echo "backed up config.yaml -> config.yaml.prephase4"
fi
# Always keep a timestamped backup too (idempotent re-runs stay auditable).
cp -a "$HH/config.yaml" "$HH/config.yaml.bak.$STAMP" 2>/dev/null || true

if grep -qE '^\s*gbrain\s*:' "$HH/config.yaml" 2>/dev/null \
   && grep -qE '^mcp_servers\s*:' "$HH/config.yaml" 2>/dev/null; then
  echo "gbrain mcp_server already registered — leaving config.yaml block intact"
else
  # Merge structurally via bun's YAML-free approach: hermes reads YAML, so we
  # append a well-formed mcp_servers block only if absent. We do NOT rewrite the
  # whole file (other phases own the rest of config.yaml).
  if grep -qE '^mcp_servers\s*:' "$HH/config.yaml" 2>/dev/null; then
    echo "ERROR: mcp_servers block exists without a gbrain entry — refusing to blind-append."
    echo "       Add the gbrain entry by hand (or remove the block) and re-run. Block to add:"
    SHOW_ONLY=1
  fi
  BLOCK_FILE="$(mktemp)"
  cat > "$BLOCK_FILE" <<YAML

# --- hermesBOX Phase 4 (UMB-383): gbrain memory over MCP ---
mcp_servers:
  gbrain:
    command: "${GBRAIN_BIN}"
    args: ["serve"]                 # stdio MCP server (src/commands/serve.ts)
    env:
      GBRAIN_HOME: "${GH}"          # resolve the existing brain at ~/.gbrain
      GBRAIN_EMBEDDING_MODEL: "${EMBED_MODEL}"
      GBRAIN_EMBEDDING_DIMENSIONS: "${EMBED_DIMS}"
      OLLAMA_BASE_URL: "${OLLAMA_URL}"   # local embeddings; no outbound net on embed
# --- end Phase 4 ---
YAML
  if [ "${SHOW_ONLY:-0}" = "1" ]; then
    cat "$BLOCK_FILE"; rm -f "$BLOCK_FILE"; exit 1
  fi
  cat "$BLOCK_FILE" >> "$HH/config.yaml"
  rm -f "$BLOCK_FILE"
  echo "appended mcp_servers.gbrain block to config.yaml"
fi

# ---------------------------------------------------------------------------
# 6/6 — Summary
# ---------------------------------------------------------------------------
log "6/6 — done"
echo "  gbrain binary : $GBRAIN_BIN ($("$GBRAIN_BIN" --version 2>/dev/null || echo '?'))"
echo "  brain         : $GH/brain.pglite (backup: brain.pglite.prehermesbox)"
echo "  embeddings    : $EMBED_MODEL @ ${EMBED_DIMS}d via $OLLAMA_URL"
echo "  hermes mcp    : mcp_servers.gbrain -> ${GBRAIN_BIN} serve (backup: config.yaml.prephase4)"
echo "  NOTE          : run verify-phase4.sh next; reindex (if dims changed) is operator-gated."
echo "PHASE4_GBRAIN_DONE"
