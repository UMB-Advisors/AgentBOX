#!/usr/bin/env bash
# Single source of truth for the AgentBOX-custom dashboard BACKEND file set.
#
# Both the remote-push deploy (bin/deploy-dashboard.sh) and the on-box installer
# (install/agentbox-install.sh STAGE 7.6) consume this so they can never drift.
# Drift is exactly what broke Google connect on agentbox2: a hand-maintained list
# silently dropped dashboard_auth/public_paths.py (which allowlists the
# /api/google/auth/* OAuth callbacks past the dashboard auth gate), so the route
# 401'd even though web_server.py defined it.
#
# The set is everything under hermes_cli/*.py that diverges from the stock upstream
# import — derived from git so new custom modules are picked up automatically.
# Falls back to a static list when git history isn't available (e.g. a tarball
# checkout on the box).

# Stock upstream import commit: "chore(hermesbox): initial import of HermesBOX
# appliance sources". Everything after it under hermes_cli/ is AgentBOX-custom.
ABX_STOCK_IMPORT="${ABX_STOCK_IMPORT:-9a8c7c0}"

# Fallback when git isn't usable. Keep roughly current, but git derivation is
# authoritative whenever it works.
ABX_STATIC_BACKEND=(
  web_server.py
  google_brief.py
  google_accounts.py
  google_people.py
  shopify_accounts.py
  agent_templates.py
  onboarding_state.py
  dashboard_auth/public_paths.py
)

# abx_custom_backend_files <vendored-hermes-root>
#   <vendored-hermes-root> = the dir containing hermes_cli/ (…/hermes-agent-main/hermes-agent-main)
# Prints one path per line, relative to hermes_cli/ (e.g. "web_server.py",
# "dashboard_auth/public_paths.py").
abx_custom_backend_files() {
  local hermes_root="$1" out=""
  if git -C "$hermes_root" rev-parse --git-dir >/dev/null 2>&1; then
    out="$(
      cd "$hermes_root" \
        && git diff --name-only --diff-filter=ACMRT "$ABX_STOCK_IMPORT" HEAD -- hermes_cli/ 2>/dev/null \
           | sed -E 's#^(.*/)?hermes_cli/##' \
           | grep -E '\.py$' \
           | grep -v '/web_dist/' \
           | sort
    )"
  fi
  if [ -n "$out" ]; then
    printf '%s\n' "$out"
  else
    printf '%s\n' "${ABX_STATIC_BACKEND[@]}"
  fi
}
