#!/usr/bin/env bash
# hermesBOX — Phase 1: Ollama + Hermes-3-3B local inference (idempotent)
# Spec: docs/PRD-v1.0.0.md §8 Phase 1 · docs/CONTEXT-phase-1-v1.0.0.md · Linear UMB-380
set -euo pipefail

MODEL="hermes3:3b"   # Nous Hermes 3 Llama 3.2 3B, Q4_K_M (DR-002)

log() { printf '\n\033[1;36m[phase1]\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
log "1/4 — install Ollama (JetPack/Tegra CUDA build, systemd service)"
if ! have ollama; then
  curl -fsSL https://ollama.com/install.sh | sh
else
  echo "ollama already present: $(ollama --version 2>/dev/null)"
fi

# ---------------------------------------------------------------------------
log "2/4 — systemd override: local bind + memory caps for the 8GB budget"
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/hermesbox.conf >/dev/null <<'EOF'
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_KEEP_ALIVE=5m"
Environment="OLLAMA_CONTEXT_LENGTH=8192"
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now ollama

# ---------------------------------------------------------------------------
log "3/4 — wait for the Ollama API to come up"
for i in $(seq 1 30); do
  if curl -fsS 127.0.0.1:11434/api/version >/dev/null 2>&1; then
    echo "ollama API up: $(curl -fsS 127.0.0.1:11434/api/version)"; break
  fi
  sleep 2
done

# ---------------------------------------------------------------------------
log "4/4 — pull ${MODEL} (~2GB; Q4_K_M)"
if ollama list 2>/dev/null | grep -q "^${MODEL%%:*}"; then
  echo "${MODEL} family already pulled:"; ollama list | grep "${MODEL%%:*}" || true
fi
ollama pull "${MODEL}"
echo "--- ollama list ---"; ollama list

log "Phase 1 provisioning complete. Run verify-phase1.sh to check acceptance criteria."
