#!/usr/bin/env bash
# hermesBOX — Phase 2 (install step): hermes-agent via official installer, non-interactive.
# Spec: docs/PRD-v1.0.0.md §8 Phase 2 · docs/CONTEXT-phase-2-v1.0.0.md · Linear UMB-381
# Config + gateway are applied as separate verified steps after this completes.
set -euo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true

log() { printf '\n\033[1;36m[phase2-install]\033[0m %s\n' "$*"; }

export HERMES_HOME="${HOME}/.hermes"
export HERMES_ACCEPT_HOOKS=1

log "Installing hermes-agent (non-interactive, --skip-setup). uv venv py3.11, ~/.local/bin/hermes."
if command -v hermes >/dev/null 2>&1; then
  echo "hermes already installed: $(hermes --version 2>/dev/null || echo present)"
else
  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
    | bash -s -- --skip-setup
fi

log "Post-install probe"
which hermes || { echo "hermes not on PATH after install"; exit 1; }
hermes --version 2>/dev/null || true
echo "HERMES_HOME=${HERMES_HOME}"
ls -la "${HERMES_HOME}" 2>/dev/null | head
echo "INSTALL_DONE"
