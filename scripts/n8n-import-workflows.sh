#!/usr/bin/env bash
# scripts/n8n-import-workflows.sh — STAQPRO-139
#
# Import the canonical n8n workflows from n8n/workflows/ into a target
# appliance. Used to bootstrap a new appliance (customer #2 onwards) so
# its workflows match master from day one.
#
# Usage:
#   scripts/n8n-import-workflows.sh                     # default: mailbox1
#   SSH_HOST=jetson-dustin ./scripts/n8n-import-workflows.sh
#   SSH_HOST=local ./scripts/n8n-import-workflows.sh    # run on the appliance itself
#
# After import:
#   1. Open n8n UI on the target appliance
#   2. For each imported workflow, open the credential-bearing nodes
#      (Postgres, Gmail OAuth2) and re-link to the appliance-local credential
#      records (credential IDs differ across appliances).
#   3. Activate the workflows that should run on the schedule trigger
#      (typically: MailBOX, MailBOX-Send). Sub-workflows (MailBOX-Classify,
#      MailBOX-Draft) stay inactive — they're invoked via executeWorkflow.
#   4. Restart n8n to pick up activation state changes
#      (`docker compose restart n8n`).
#   5. Smoke-test per dashboard/n8n-workflows/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IN_DIR="${REPO_ROOT}/n8n/workflows"
SSH_HOST="${SSH_HOST:-mailbox1}"
N8N_CONTAINER="${N8N_CONTAINER:-mailbox-n8n-1}"

WORKFLOWS=(
  "MailBOX.json"
  "MailBOX-Classify.json"
  "MailBOX-Draft.json"
  "MailBOX-Send.json"
)

import_one() {
  local filename="$1"
  local in_path="${IN_DIR}/${filename}"
  if [[ ! -f "${in_path}" ]]; then
    echo "  [skip] ${filename} (not found at ${in_path})" >&2
    return
  fi

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
for filename in "${WORKFLOWS[@]}"; do
  import_one "${filename}"
done

echo ""
echo "Done. Next steps:"
echo "  1. Re-link credentials in the n8n UI for each imported workflow."
echo "  2. Activate MailBOX (schedule) + MailBOX-Send (webhook)."
echo "  3. Restart n8n to pick up activation:"
echo "       ssh ${SSH_HOST} 'cd ~/mailbox && docker compose restart n8n'"
