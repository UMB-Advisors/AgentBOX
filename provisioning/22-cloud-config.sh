#!/usr/bin/env bash
# hermesBOX — Cloud inference pivot (ADDENDUM-001).
# Ollama -> embeddings only; hermes-agent -> OpenAI primary + OpenRouter fallback.
# Idempotent. Does NOT write real API keys (provisioned separately into ~/.hermes/.env).
# Spec: docs/PRD-ADDENDUM-001-cloud-inference.md · Linear UMB-381
set -euo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true
HH="${HERMES_HOME:-$HOME/.hermes}"
log(){ printf '\n\033[1;36m[cloud-config]\033[0m %s\n' "$*"; }

# --- 1. Ollama -> embeddings only -----------------------------------------
log "Reset Ollama to a minimal embeddings service (drop 64K/KV/flash chat tuning)"
sudo tee /etc/systemd/system/ollama.service.d/hermesbox.conf >/dev/null <<'EOF'
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_KEEP_ALIVE=5m"
Environment="OLLAMA_MAX_LOADED_MODELS=2"
EOF
sudo systemctl daemon-reload && sudo systemctl restart ollama
for i in $(seq 1 30); do curl -fsS 127.0.0.1:11434/api/version >/dev/null 2>&1 && break; sleep 2; done

log "Pull embedding model nomic-embed-text (~274MB)"
ollama pull nomic-embed-text

log "Remove chat model hermes3:3b (reclaim ~2GB; no longer used)"
ollama rm hermes3:3b 2>/dev/null || echo "hermes3:3b already absent"
echo "--- ollama models now ---"; ollama list

# --- 2. hermes-agent -> cloud (OpenAI primary) ----------------------------
log "Rewrite $HH/config.yaml for cloud inference (OpenAI Codex on ChatGPT subscription)"
cp "$HH/config.yaml" "$HH/config.yaml.precloud" 2>/dev/null || true
# PREREQ (one-time, interactive — run in a real TTY):
#   hermes auth add openai-codex --type oauth --no-browser --manual-paste
#   -> sign in with ChatGPT (Plus/Pro/Team); uses subscription, no API credits.
cat > "$HH/config.yaml" <<'YAML'
# hermesBOX — cloud inference (ADDENDUM-001). Primary: OpenAI Codex via ChatGPT sub.
model:
  default: "gpt-5.3-codex"    # Codex model allowed for ChatGPT-account auth (gpt-5-codex is NOT)
  provider: "openai-codex"    # OAuth subscription; fallback to openrouter via `hermes fallback`
  max_tokens: 8192
agent:
  reasoning_effort: "medium"
terminal:
  backend: "local"
  cwd: "."
  timeout: 180
  sudo_password: ""            # passwordless sudo present
display:
  compact: false
  streaming: true
YAML

# --- 3. .env: drop the local Ollama base_url; keep non-secrets; key slots --
log "Rewrite $HH/.env (remove local base_url; real keys provisioned separately)"
cp "$HH/.env" "$HH/.env.precloud" 2>/dev/null || true
# Preserve any already-real keys
OAI=$(grep -E '^OPENAI_API_KEY=' "$HH/.env" 2>/dev/null | cut -d= -f2-)
ORK=$(grep -E '^OPENROUTER_API_KEY=' "$HH/.env" 2>/dev/null | cut -d= -f2-)
[ "$OAI" = "ollama" ] && OAI=""    # the old dummy is not a real key
umask 077
cat > "$HH/.env" <<ENV
HERMES_ACCEPT_HOOKS=1
TERMINAL_ENV=local
OPENAI_API_KEY=${OAI}
OPENROUTER_API_KEY=${ORK}
ENV
chmod 600 "$HH/.env"

log "Done. config.yaml -> OpenAI/gpt-4o; .env has empty OPENAI_API_KEY/OPENROUTER_API_KEY slots."
echo "Keys present? OPENAI_API_KEY $( [ -n \"$OAI\" ] && echo set || echo EMPTY ) · OPENROUTER_API_KEY $( [ -n \"$ORK\" ] && echo set || echo EMPTY )"
echo "CLOUD_CONFIG_DONE"
