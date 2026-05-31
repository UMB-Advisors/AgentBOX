#!/usr/bin/env bash
# hermesBOX — Phase 2 (config step): point hermes-agent at local Ollama.
# Writes ~/.hermes/config.yaml and ~/.hermes/.env (idempotent), then prints CLI help
# so the exact non-interactive chat/gateway invocations can be confirmed live.
# Spec: docs/CONTEXT-phase-2-v1.0.0.md · Linear UMB-381
set -euo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true
HH="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HH"

log() { printf '\n\033[1;36m[phase2-config]\033[0m %s\n' "$*"; }

# --- config.yaml (back up any existing once) ------------------------------
if [ -f "$HH/config.yaml" ] && [ ! -f "$HH/config.yaml.prehermesbox" ]; then
  cp "$HH/config.yaml" "$HH/config.yaml.prehermesbox"
  echo "backed up existing config.yaml -> config.yaml.prehermesbox"
fi
log "writing $HH/config.yaml (local Ollama / custom provider)"
cat > "$HH/config.yaml" <<'YAML'
# hermesBOX — local-first config. Cloud providers added in Phase 3.
model:
  default: "hermes3:3b"
  provider: "custom"            # ollama/vllm/llamacpp all map to custom
  base_url: "http://127.0.0.1:11434/v1"
  context_length: 8192          # matches Ollama OLLAMA_CONTEXT_LENGTH
providers:
  custom:
    request_timeout_seconds: 300   # local cold-start headroom
    stale_timeout_seconds: 900
terminal:
  backend: "local"
  cwd: "."
  timeout: 180
  sudo_password: ""             # passwordless sudo present; "" = no interactive prompt
agent:
  reasoning_effort: "medium"
display:
  compact: false
  streaming: true
YAML

# --- .env (dummy local key; real secrets only arrive in Phase 3) -----------
if [ -f "$HH/.env" ] && [ ! -f "$HH/.env.prehermesbox" ]; then
  cp "$HH/.env" "$HH/.env.prehermesbox"
  echo "backed up existing .env -> .env.prehermesbox"
fi
log "writing $HH/.env (local endpoint + dummy key)"
umask 077
cat > "$HH/.env" <<'ENV'
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
OPENAI_API_KEY=ollama
HERMES_ACCEPT_HOOKS=1
TERMINAL_ENV=local
ENV
chmod 600 "$HH/.env"

log "hermes --version"; hermes --version 2>/dev/null || true
log "hermes --help (top-level subcommands)"; hermes --help 2>&1 | sed -n '1,60p' || true
log "hermes chat --help (look for non-interactive / one-shot prompt flag)"; hermes chat --help 2>&1 | sed -n '1,50p' || true
log "hermes gateway --help (look for how to start the :8642 API platform)"; hermes gateway --help 2>&1 | sed -n '1,60p' || true
echo "CONFIG_DONE"
