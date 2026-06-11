#!/usr/bin/env bash
# scripts/n8n-export-workflows.sh — STAQPRO-139 (full-fleet rewrite 2026-06-11)
#
# Export ALL MailBOX* n8n workflows from the appliance into n8n/workflows/
# as the canonical, version-controlled JSON. Stable across re-exports
# (volatile fields like versionCounter, instanceId, triggerCount are stripped),
# so a re-export against an unchanged appliance produces a no-op diff.
#
# The workflow list is discovered live (`n8n export:workflow --all`), NOT
# hardcoded — workflows created in the n8n UI on the box are picked up
# automatically. This is the drift-killer: run after EVERY workflow edit
# on a box and commit the diff. Live workflows with no matching repo file
# and repo files with no matching live workflow are both reported.
#
# Usage:
#   scripts/n8n-export-workflows.sh             # default: against mailbox1
#   SSH_HOST=jetson-dustin ./scripts/n8n-export-workflows.sh
#   SSH_HOST=UMB@100.127.2.54 ./scripts/n8n-export-workflows.sh   # agentbox2
#   SSH_HOST=local ./scripts/n8n-export-workflows.sh   # run on the box itself
#
# If the n8n container isn't mailbox-n8n-1, override N8N_CONTAINER
# (find it with: docker ps --format '{{.Names}}' | grep n8n).
#
# Requires: jq, ssh access to a host with docker (unless SSH_HOST=local).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${REPO_ROOT}/n8n/workflows"
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

mkdir -p "${OUT_DIR}"

echo "Exporting from ${SSH_HOST}:${N8N_CONTAINER} → ${OUT_DIR}/"

all_json="$(run_n8n_cmd n8n export:workflow --all 2>/dev/null)"
if [[ -z "${all_json}" ]]; then
  echo "[fail] export:workflow --all produced no output" >&2
  exit 1
fi

# One repo file per workflow whose name starts with "MailBOX".
# Filename = workflow name + .json (names contain no path-hostile chars).
exported_names=()
while IFS= read -r name; do
  out_path="${OUT_DIR}/${name}.json"
  # Normalize: pretty-print + sort keys + strip volatile fields so
  # re-exports of the same workflow produce no-op diffs.
  echo "${all_json}" | jq --sort-keys --arg name "${name}" '
    [ .[] | select(.name == $name) ][0]
    | del(.updatedAt)
    | del(.createdAt)
    | del(.versionCounter)
    | del(.versionId)
    | del(.activeVersionId)
    | del(.triggerCount)
    | del(.meta.instanceId)
    | del(.shared)
  ' > "${out_path}"
  exported_names+=("${name}")
  echo "  [ok]   ${name} → ${name}.json ($(wc -c < "${out_path}") bytes)"
done < <(echo "${all_json}" | jq -r '.[] | select(.name | startswith("MailBOX")) | .name' | sort)

# Live workflows we did NOT export (non-MailBOX names) — surfaced so an
# unconventionally named workflow can't drift invisibly.
skipped="$(echo "${all_json}" | jq -r '.[] | select(.name | startswith("MailBOX") | not) | .name')"
if [[ -n "${skipped}" ]]; then
  echo ""
  echo "[warn] live workflows NOT exported (name doesn't start with MailBOX):"
  echo "${skipped}" | sed 's/^/         /'
fi

# Repo files with no matching live workflow — stale exports or a box that
# is missing a workflow it should have.
echo ""
for f in "${OUT_DIR}"/MailBOX*.json; do
  base="$(basename "${f}" .json)"
  found=0
  for name in "${exported_names[@]}"; do
    [[ "${name}" == "${base}" ]] && found=1 && break
  done
  if [[ "${found}" -eq 0 ]]; then
    echo "[warn] repo file with no live counterpart on ${SSH_HOST}: ${base}.json"
  fi
done

echo "Done. Review the git diff, then commit."
