#!/usr/bin/env bash
# scripts/n8n-export-workflows.sh — STAQPRO-139
#
# Export the 4 active n8n workflows from the appliance into n8n/workflows/
# as the canonical, version-controlled JSON. Stable across re-exports
# (volatile fields like versionCounter, instanceId, triggerCount are stripped),
# so a re-export against an unchanged appliance produces a no-op diff.
#
# Usage:
#   scripts/n8n-export-workflows.sh             # default: against mailbox1
#   SSH_HOST=jetson-dustin ./scripts/n8n-export-workflows.sh
#   SSH_HOST=local ./scripts/n8n-export-workflows.sh   # run on Bob itself
#
# Requires: jq, ssh access to a host with `docker exec mailbox-n8n-1 ...`
# (unless SSH_HOST=local).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${REPO_ROOT}/n8n/workflows"
SSH_HOST="${SSH_HOST:-mailbox1}"
N8N_CONTAINER="${N8N_CONTAINER:-mailbox-n8n-1}"

# (workflow-id, output-filename) pairs. Keep this in sync with
# `n8n list:workflow` output. Legacy/deactivated workflows live under
# n8n/workflows/legacy/ and are not part of the round-trip.
WORKFLOWS=(
  "C3kG7uKyRgxXpcJv:MailBOX.json"
  "MlbxClsfySub0001:MailBOX-Classify.json"
  "MlbxDraftSub0001:MailBOX-Draft.json"
  "mailbox-send:MailBOX-Send.json"
)

run_n8n_cmd() {
  if [[ "${SSH_HOST}" == "local" ]]; then
    docker exec "${N8N_CONTAINER}" "$@"
  else
    # shellcheck disable=SC2029
    ssh "${SSH_HOST}" "docker exec ${N8N_CONTAINER} $*"
  fi
}

mkdir -p "${OUT_DIR}"

echo "Exporting from ${SSH_HOST}:${N8N_CONTAINER} → ${OUT_DIR}/"

for entry in "${WORKFLOWS[@]}"; do
  IFS=':' read -r id filename <<< "${entry}"
  out_path="${OUT_DIR}/${filename}"

  raw_json="$(run_n8n_cmd n8n export:workflow --id="${id}" 2>/dev/null)"
  if [[ -z "${raw_json}" ]]; then
    echo "  [fail] ${id} → ${filename} (empty output)" >&2
    exit 1
  fi

  # Normalize: pretty-print + sort keys + strip volatile fields so
  # re-exports of the same workflow produce no-op diffs.
  echo "${raw_json}" | jq --sort-keys '
    .[0]
    | del(.updatedAt)
    | del(.createdAt)
    | del(.versionCounter)
    | del(.versionId)
    | del(.activeVersionId)
    | del(.triggerCount)
    | del(.meta.instanceId)
    | del(.shared)
  ' > "${out_path}"

  echo "  [ok]   ${id} → ${filename} ($(wc -c < "${out_path}") bytes)"
done

echo "Done."
