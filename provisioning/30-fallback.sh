#!/usr/bin/env bash
# hermesBOX — Phase 3: fallback provider chain (idempotent)
# Wire OpenRouter + direct OpenAI API as fallbacks behind the primary
# openai-codex/gpt-5.3-codex brain. Fallbacks are tried in order when the
# primary errors (rate-limit, 5xx, connection) — see hermes-agent docs.
# Spec: docs/PRD-ADDENDUM-001-cloud-inference.md DR-008/DR-004 · Linear UMB-382
#
# WHY direct config write (not `hermes fallback add`):
#   `hermes fallback add` is TTY-ONLY. It calls _require_tty("fallback add")
#   and then drives the SAME curses picker as `hermes model`
#   (select_provider_and_model). There is NO provider/model flag, env var, or
#   stdin path — piping into it exits with an error. So this script writes the
#   exact same persisted structure the CLI would write: a top-level
#   `fallback_providers:` list of {provider, model} dicts in ~/.hermes/config.yaml.
#   It uses the agent's OWN load_config()/save_config() so config-lock, profile
#   handling, and other top-level keys are preserved (verified against
#   hermes_cli/fallback_cmd.py and hermes_cli/fallback_config.py @ v0.15.1).
#
# NOTE ON KEYS (read this): the providers below are wired NOW but only become
#   EFFECTIVE once funded. As of provisioning:
#     - OPENROUTER_API_KEY  : present but low balance -> 402 (needs top-up)
#     - OPENAI_API_KEY (sk-) : present but unfunded   -> quota exceeded (needs billing)
#   The chain is correct and inert until then; no behavior change until funded.
#   Funding is a HUMAN-IN-THE-LOOP step (see bottom + verify-phase3.sh).
set -euo pipefail
. "${HOME}/.hermesbox_env.sh" 2>/dev/null || true
HH="${HERMES_HOME:-$HOME/.hermes}"
log(){ printf '\n\033[1;36m[fallback]\033[0m %s\n' "$*"; }

# --- Pinned fallback chain (order matters; tried top-down after primary) -----
# Provider names are the canonical hermes provider ids (confirmed via `hermes
# auth list`: openai-codex, openrouter, openai-api are all authed). base_url is
# omitted intentionally — each provider's HermesOverlay supplies base_url_override
# (openrouter -> OpenRouter; openai-api -> https://api.openai.com/v1), matching
# how the picker writes entries (base_url only stored when user-customized).
#
#   1. openrouter / openai/gpt-4o   -> model variety + strong tool-calling
#      (swap to anthropic/claude-3.5-sonnet for an Anthropic fallback instead)
#   2. openai-api / gpt-4o          -> direct OpenAI API key path
FB_PROVIDER_1="openrouter"
FB_MODEL_1="openai/gpt-4o"
FB_PROVIDER_2="openai-api"
FB_MODEL_2="gpt-4o"

# --- 1. Back up config before mutating --------------------------------------
log "Back up $HH/config.yaml -> config.yaml.prefallback"
cp "$HH/config.yaml" "$HH/config.yaml.prefallback" 2>/dev/null || true

# --- 2. Write/merge the fallback chain via the agent's own config IO ---------
# Idempotent: re-running dedupes on (provider, model) exactly like the CLI's
# `hermes fallback add` (fallback_cmd.cmd_fallback_add rejects exact dupes).
log "Wire fallback chain: openai-codex(primary) -> ${FB_PROVIDER_1}/${FB_MODEL_1} -> ${FB_PROVIDER_2}/${FB_MODEL_2}"
HB_FB1_PROVIDER="$FB_PROVIDER_1" HB_FB1_MODEL="$FB_MODEL_1" \
HB_FB2_PROVIDER="$FB_PROVIDER_2" HB_FB2_MODEL="$FB_MODEL_2" \
"${HH}/hermes-agent/venv/bin/python" - <<'PY'
import os, sys
# Use the installed hermes_cli so config-lock + profile handling match the CLI.
try:
    from hermes_cli.config import load_config, save_config
    from hermes_cli.fallback_config import get_fallback_chain
except Exception as e:
    sys.exit(f"ERROR: cannot import hermes_cli (is ~/.hermesbox_env.sh sourced / venv active?): {e}")

desired = [
    {"provider": os.environ["HB_FB1_PROVIDER"], "model": os.environ["HB_FB1_MODEL"]},
    {"provider": os.environ["HB_FB2_PROVIDER"], "model": os.environ["HB_FB2_MODEL"]},
]

cfg = load_config()
chain = get_fallback_chain(cfg)  # normalized, merges legacy fallback_model

def ident(e):
    return (str(e.get("provider","")).strip().lower(),
            str(e.get("model","")).strip().lower())

seen = {ident(e) for e in chain}
added = []
for entry in desired:
    if ident(entry) in seen:
        continue
    chain.append(entry)
    seen.add(ident(entry))
    added.append(entry)

# Persist to the canonical key; drop the legacy single-dict key (matches
# fallback_cmd._write_chain).
cfg["fallback_providers"] = chain
cfg.pop("fallback_model", None)
save_config(cfg)

if added:
    print("ADDED: " + ", ".join(f"{e['provider']}/{e['model']}" for e in added))
else:
    print("ADDED: (none — chain already up to date)")
print("CHAIN: " + " -> ".join(f"{e['provider']}/{e['model']}" for e in chain))
PY

# --- 3. Show the resulting chain through the CLI (read-only) ------------------
log "hermes fallback list (post-write)"
hermes fallback list || true

log "Done. Fallback chain wired. Effective once OpenRouter/OpenAI keys are funded."
echo "HUMAN-IN-THE-LOOP: fund providers, then re-run verify-phase3.sh"
echo "  - OpenRouter: https://openrouter.ai/credits  (top up; sets OPENROUTER_API_KEY usable)"
echo "  - OpenAI API: https://platform.openai.com/account/billing  (add billing for sk- key)"
echo "FALLBACK_CONFIG_DONE"
