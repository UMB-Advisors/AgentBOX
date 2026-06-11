#!/usr/bin/env bash
# scripts/n8n-import-workflows.sh — STAQPRO-139 (full-fleet rewrite 2026-06-11)
#
# Import the canonical n8n workflows from n8n/workflows/ into a target
# appliance. Used to bootstrap a new appliance (customer #2 onwards) so
# its workflows match master from day one, and to push repo-side workflow
# edits to a running box.
#
# Imports every n8n/workflows/MailBOX*.json (discovered, not hardcoded),
# then activates ALL of them. n8n 2.x requires every workflow active=true —
# the pre-2.x "sub-workflows stay inactive" guidance was retracted by
# STAQPRO-181 (2.x throws "Workflow is not active and cannot be executed"
# and dark-classifies the inbox until caught).
#
# Usage:
#   scripts/n8n-import-workflows.sh                     # default: mailbox1
#   SSH_HOST=jetson-dustin ./scripts/n8n-import-workflows.sh
#   SSH_HOST=UMB@100.127.2.54 ./scripts/n8n-import-workflows.sh   # agentbox2
#   SSH_HOST=local ./scripts/n8n-import-workflows.sh    # run on the box itself
#
# After import (REQUIRED, in order):
#   1. Re-link credential-bearing nodes in the n8n UI (Postgres, Gmail
#      OAuth2, IMAP/SMTP) — credential IDs differ across appliances.
#   2. Restart n8n: `docker compose restart n8n` — both the CLI activate
#      below AND any `update:workflow --active` are no-ops at runtime
#      without a restart.
#   3. For WEBHOOK-triggered workflows, n8n 2.x runtime reads the
#      PUBLISHED version, not workflow_entity — if a webhook workflow
#      doesn't fire after import, open it in the editor and Publish.
#   4. Gate: `docker compose --profile n8n-verify run --rm mailbox-n8n-verify`
#      (exit 0 = all required workflows active).
#   5. Smoke-test per n8n/workflows/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IN_DIR="${REPO_ROOT}/n8n/workflows"
SSH_HOST="${SSH_HOST:-mailbox1}"
N8N_CONTAINER="${N8N_CONTAINER:-mailbox-n8n-1}"

run_n8n_cmd() {
  if [[ "${SSH_HOST}" == "local" ]]; then
    docker exec "${N8N_CONTAINER}" "$@"
  else
    # shellcheck disable=SC2029
    ssh "${SSH_HOST}" "docker exec ${N8N_CONTAINER} $*"
  fi
}

import_one() {
  local filename="$1"
  local in_path="${IN_DIR}/${filename}"
  local tmp_path="/tmp/n8n-import-${filename}"

  if [[ "${SSH_HOST}" == "local" ]]; then
    cp "${in_path}" "${tmp_path}"
    docker cp "${tmp_path}" "${N8N_CONTAINER}:/tmp/${filename}"
    docker exec "${N8N_CONTAINER}" n8n import:workflow --input="/tmp/${filename}"
    docker exec "${N8N_CONTAINER}" rm -f "/tmp/${filename}"
    rm -f "${tmp_path}"
  else
    # Stage on remote host, then docker cp + import.
    scp "${in_path}" "${SSH_HOST}:${tmp_path}" >/dev/null
    # shellcheck disable=SC2029
    ssh "${SSH_HOST}" "
      docker cp '${tmp_path}' '${N8N_CONTAINER}:/tmp/${filename}' &&
      docker exec '${N8N_CONTAINER}' n8n import:workflow --input='/tmp/${filename}' &&
      docker exec '${N8N_CONTAINER}' rm -f '/tmp/${filename}' &&
      rm -f '${tmp_path}'
    "
  fi
  echo "  [ok]   ${filename}"
}

echo "Importing from ${IN_DIR}/ → ${SSH_HOST}:${N8N_CONTAINER}"
shopt -s nullglob
workflow_files=("${IN_DIR}"/MailBOX*.json)
shopt -u nullglob
if [[ "${#workflow_files[@]}" -eq 0 ]]; then
  echo "[fail] no MailBOX*.json files found in ${IN_DIR}" >&2
  exit 1
fi

for f in "${workflow_files[@]}"; do
  import_one "$(basename "${f}")"
done

# n8n 2.x: ALL workflows must be active (import:workflow defaults to
# active=false). Workflow ids live in each JSON's .id field.
echo ""
echo "Activating all imported workflows (n8n 2.x requirement)..."
for f in "${workflow_files[@]}"; do
  id="$(jq -r '.id' "${f}")"
  run_n8n_cmd n8n update:workflow --active=true --id="${id}" >/dev/null
  echo "  [active] $(basename "${f}" .json) (${id})"
done

echo ""
echo "Done. REQUIRED next steps (activation is NOT live yet):"
echo "  1. Re-link credentials in the n8n UI for each imported workflow."
echo "  2. Restart n8n (CLI activation is a no-op at runtime until restart):"
echo "       ssh ${SSH_HOST} 'cd ~/mailbox && docker compose restart n8n'"
echo "  3. Webhook workflows not firing? Open in editor + Publish (2.x"
echo "     publish/draft duality — runtime reads the published version)."
echo "  4. Verify: docker compose --profile n8n-verify run --rm mailbox-n8n-verify"
