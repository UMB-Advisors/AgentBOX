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
  config.py
  google_brief.py
  google_accounts.py
  google_people.py
  shopify_accounts.py
  agent_templates.py
  mail_accounts.py
  mail_probe.py
  token_crypto.py
  gemini_notes.py
  dashboard_bridge.py
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

# Non-.py custom assets that must ALSO ship to the box for features that aren't
# pure backend Python. The git-derived backend set above is .py-only, so these
# were silently never deployed — which is why agentbox2 shows the Brain Graph
# "not generated yet" placeholder (the viewer bundle never arrived).
#
#   hermes_cli/graph_app/         the static Understand-Anything viewer bundle the
#                                 Brain Graph tab iframes at /graph-app/.
#   tools/gbrain-graph-export.ts  the gbrain → UA adapter the dashboard's
#                                 "Generate Brain Graph" button runs. web_server.py
#                                 self-installs it into $GBRAIN_DIR/src/tools/ at
#                                 generate time (its relative imports require the
#                                 gbrain source tree), so it only needs to LAND in
#                                 the hermes tree — see _run_graph_export.
#
# Paths are relative to the hermes root (the dir containing hermes_cli/), shipped
# preserving structure so they land in the box's runtime layout.
ABX_CUSTOM_EXTRAS=(
  hermes_cli/graph_app
  tools/gbrain-graph-export.ts
)

# abx_custom_extras <vendored-hermes-root>
#   Prints one existing extra path per line (relative to the hermes root).
#   Silently skips any absent from the checkout (forward-compatible).
abx_custom_extras() {
  local hermes_root="$1" p
  for p in "${ABX_CUSTOM_EXTRAS[@]}"; do
    [ -e "$hermes_root/$p" ] && printf '%s\n' "$p"
  done
}
